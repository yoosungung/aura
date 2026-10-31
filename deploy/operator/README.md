# operator

계정·유저 Platform API CRUD. Bearer `AURA_PLATFORM_TOKEN`. 게이트웨이는 PG에 쓰지 않고 `helpdesk.rpc.platform.*`로 넘긴다.

```sh
cp deploy/operator/.env.example deploy/operator/.env
# AURA_PLATFORM_TOKEN, AURA_GATEWAY_URL 을 채운다.

node --test deploy/operator/lib.test.mjs
node deploy/operator/aura.mjs accounts list
```

기본 URL은 `http://127.0.0.1:8080` (`gateway-web`). 목록·수정·삭제는 `gateway-web`과 `svc-core`가 `helpdesk.rpc.platform.accounts.*` / `users.*`를 받을 때 동작한다. 클러스터면 프론트 NodePort는 `/platform`을 프록시하지 않으므로:

```sh
kubectl -n aura port-forward svc/gateway-web 8080:8080
```

토큰은 환경변수 또는 이 디렉터리 `.env`. 이미 있는 환경변수는 `.env`가 덮어쓰지 않는다. 클러스터 시크릿:

```sh
kubectl -n aura get secret aura-secrets -o jsonpath='{.data.AURA_PLATFORM_TOKEN}' | base64 -d; echo
```

```sh
node deploy/operator/aura.mjs accounts create --name pilot --locale ko \
  --user-name Ada --email ada@pilot.test --password s3cret12
node deploy/operator/aura.mjs accounts list
node deploy/operator/aura.mjs accounts update --id ACCOUNT_ID --name renamed
node deploy/operator/aura.mjs accounts delete --id ACCOUNT_ID

node deploy/operator/aura.mjs users create --account-id ACCOUNT_ID \
  --name Bob --email bob@pilot.test --password s3cret12 --role agent
node deploy/operator/aura.mjs users list --account-id ACCOUNT_ID
node deploy/operator/aura.mjs users update --id USER_ID --name Robert
node deploy/operator/aura.mjs users delete --id USER_ID
```
