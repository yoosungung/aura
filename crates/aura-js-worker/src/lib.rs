//! JetStream pull worker — Node `hardcoded-runtime/jetstream-worker.js` parity.
//! Handler returns `(status, body_bytes)`; status ≥ 400 → ERROR_TOPIC else RESP_TOPIC.

use std::env;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use async_nats::jetstream::{
    self,
    consumer::{pull, AckPolicy, DeliverPolicy},
};
use bytes::Bytes;
use futures_util::StreamExt;
use serde_json::json;
use thiserror::Error;

pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<(u16, Bytes), String>> + Send>>;
pub type Handler = Box<dyn Fn(Bytes) -> HandlerFuture + Send + Sync>;

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("env_required:{0}")]
    EnvRequired(&'static str),
    #[error("nats:{0}")]
    Nats(String),
}

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub nats_url: String,
    pub stream: String,
    pub subject: String,
    pub durable: String,
    pub resp_topic: String,
    pub error_topic: String,
    pub ack_wait: Duration,
    pub max_deliver: i64,
    pub max_ack_pending: i64,
}

impl WorkerConfig {
    pub fn from_env() -> Result<Self, WorkerError> {
        Ok(Self {
            nats_url: env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into()),
            stream: env::var("STREAM").unwrap_or_else(|_| "AURA_TASKS".into()),
            subject: env::var("TASK_SUBJECT")
                .map_err(|_| WorkerError::EnvRequired("TASK_SUBJECT"))?,
            durable: env::var("DURABLE").map_err(|_| WorkerError::EnvRequired("DURABLE"))?,
            resp_topic: env::var("RESP_TOPIC")
                .map_err(|_| WorkerError::EnvRequired("RESP_TOPIC"))?,
            error_topic: env::var("ERROR_TOPIC")
                .map_err(|_| WorkerError::EnvRequired("ERROR_TOPIC"))?,
            ack_wait: Duration::from_secs(60),
            max_deliver: 5,
            max_ack_pending: 32,
        })
    }
}

/// Connect (lab plaintext by default) and run pull consume loop until process exit.
pub async fn run_jetstream_worker(cfg: WorkerConfig, handler: Handler) -> Result<(), WorkerError> {
    let opts = aura_nats::connect_options_insecure_for_lab();
    let client = aura_nats::connect(&cfg.nats_url, opts)
        .await
        .map_err(|e| WorkerError::Nats(e.to_string()))?;
    let js = jetstream::new(client);

    let stream = js
        .get_stream(&cfg.stream)
        .await
        .map_err(|e| WorkerError::Nats(format!("get_stream: {e}")))?;

    let pull_cfg = pull::Config {
        durable_name: Some(cfg.durable.clone()),
        filter_subject: cfg.subject.clone(),
        ack_policy: AckPolicy::Explicit,
        deliver_policy: DeliverPolicy::All,
        max_deliver: cfg.max_deliver,
        ack_wait: cfg.ack_wait,
        max_ack_pending: cfg.max_ack_pending,
        ..Default::default()
    };

    // Legacy Fission MQT may leave push consumers; recreate as pull when needed.
    if let Ok(info) = stream.consumer_info(&cfg.durable).await {
        if info.config.deliver_subject.is_some() {
            let _ = stream.delete_consumer(&cfg.durable).await;
            let _ = stream.create_consumer(pull_cfg.clone()).await;
        }
    } else {
        let _ = stream.create_consumer(pull_cfg.clone()).await;
    }

    let consumer = stream
        .get_or_create_consumer(&cfg.durable, pull_cfg)
        .await
        .map_err(|e| WorkerError::Nats(format!("consumer: {e}")))?;

    eprintln!("jetstream-worker {} on {}", cfg.durable, cfg.subject);

    let mut messages = consumer
        .messages()
        .await
        .map_err(|e| WorkerError::Nats(format!("messages: {e}")))?;

    while let Some(next) = messages.next().await {
        let msg = match next {
            Ok(m) => m,
            Err(e) => {
                eprintln!("jetstream-worker message err: {e}");
                continue;
            }
        };
        let payload = msg.payload.clone();
        let result = handler(payload).await;
        let (topic, body) = match result {
            Ok((status, body)) if status >= 400 => (cfg.error_topic.as_str(), body),
            Ok((_, body)) => (cfg.resp_topic.as_str(), body),
            Err(detail) => {
                let err_body = Bytes::from(
                    json!({
                        "error": "handler_error",
                        "detail": detail,
                        "subject": cfg.subject,
                    })
                    .to_string(),
                );
                (cfg.error_topic.as_str(), err_body)
            }
        };
        if let Err(e) = js.publish(topic.to_string(), body).await {
            eprintln!("jetstream-worker publish err: {e}");
        }
        if let Err(e) = msg.ack().await {
            eprintln!("jetstream-worker ack err: {e}");
        }
    }
    Ok(())
}
