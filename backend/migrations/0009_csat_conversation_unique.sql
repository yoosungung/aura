ALTER TABLE csat_survey_responses
    ADD CONSTRAINT uq_csat_conversation UNIQUE (conversation_id);
