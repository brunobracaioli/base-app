# Spec — Ambiente local do aluno (`pnpm dev`)

> **Status:** accepted · **Contexto:** tooling (`packages/tooling/src/dev`) · **Spec principal:** [base-app.md](base-app.md)
> **ADRs:** [0002](../adr/0002-mobile-expo-react-native.md) (emenda de 2026-11-27, Expo Go e HTTP em desenvolvimento)
> **Guia:** [ambiente local com `pnpm dev`](../how-to/local-dev-stack.md) · **Tutorial:** [primeira hora](../tutorials/primeira-hora.md)

## 1. Visão geral

Cada aluno constrói o próprio app, com o próprio backend. Para começar sem criar contas, um
comando sobe, na máquina dele, tudo o que o login por e-mail precisa e abre o app no Expo Go.
Nenhum backend é compartilhado entre alunos. O ambiente é de desenvolvimento: não substitui o
Supabase hospedado nem a API na Vercel.

## 2. Requisitos

### 2.1 Funcionais

| ID | Requisito |
|----|-----------|
| LD-1 | `pnpm dev` sobe Supabase local (Auth, Postgres, Mailpit), Redis com ponte HTTP do Upstash, a API Next.js e o Metro em modo Expo Go, nessa ordem, e só inicia o Metro quando `GET /api/v1/health` responde 200. |
| LD-2 | Nenhuma conta de backend (Supabase, Upstash, Resend, Vercel) é exigida. Os e-mails de Auth chegam na caixa local (Mailpit). Exceção da plataforma: no iPhone físico, o Expo Go do SDK 58 exige o Expo CLI e o Expo Go na mesma conta Expo (grátis); `pnpm expo:login` faz o login e o `pnpm dev` avisa quando o computador não está logado. |
| LD-3 | Segredos locais (senha do `api_runtime`, token do Redis, `AUDIT_SUBJECT_KEY`, chave ES256 de assinatura do Auth) são aleatórios por máquina, gerados uma vez em `.local-dev/` (git-ignored, modo 0600). |
| LD-4 | `.env.local` (API) e `apps/mobile/.env.local` (app) recebem um bloco gerenciado no fim do arquivo. Linhas fora do bloco são preservadas. A API recebe as mesmas variáveis também pelo ambiente do processo. |
| LD-5 | O `supabase/config.toml` versionado não é alterado. A config local é derivada dele em `.local-dev/supabase/config.toml`, com portas 583xx, Studio, pooler, Analytics e Edge Runtime desligados e `signing_keys_path` local. |
| LD-6 | `pnpm dev:stop` desliga Supabase e Redis locais e preserva os dados. `pnpm dev:db:reset` recria o banco e reaplica as migrations. |
| LD-7 | O endereço do Wi-Fi é detectado automaticamente, preferindo 192.168/16, depois 10/8, depois 172.16/12, e ignorando adaptadores virtuais. `LOCAL_DEV_HOST` sobrescreve, mas aceita só IPv4 privado. |
| LD-8 | Mensagens ao aluno em pt-BR, com a ação a tomar (Docker desligado, porta em uso, IP não encontrado, API sem resposta). |

### 2.2 Não funcionais (segurança)

| ID | Requisito |
|----|-----------|
| LD-S1 | O processo abre no Wi-Fi só o portão (porta 58780) e o Metro. O portão encaminha só os endpoints públicos do Auth (`.well-known`, `factors`, `health`, `logout`, `magiclink`, `otp`, `reauthenticate`, `recover`, `resend`, `settings`, `signup`, `token`, `user`, `verify`) e `/api/*`, e responde 404 a todo o resto, inclusive `admin`/`invite` e caminhos com `%`, `\`, `//` ou segmentos `.`/`..`. |
| LD-S2 | A API escuta em `127.0.0.1`. O Redis não publica porta; a ponte HTTP publica só em `127.0.0.1`. O proxy Redis escuta só em `127.0.0.1` e não remove a autenticação por token. |
| LD-S3 | Studio e postgres-meta não sobem (acesso total ao banco sem senha). O Docker Desktop publica as portas do Supabase em todas as interfaces e o CLI não tem opção de endereço. Por isso o `pnpm dev` avisa, ao subir, que o Postgres local (senha padrão), o gateway do Supabase local e o Mailpit ficam alcançáveis na rede, e a documentação manda usar rede de confiança. |
| LD-S4 | As exceções de HTTP valem só em desenvolvimento. App: `__DEV__` e host loopback ou IPv4 privado. API: `SUPABASE_URL`/`UPSTASH_REDIS_REST_URL` em HTTP e banco sem CA só em loopback com `NODE_ENV` `development`/`test`, recusados em Vercel preview/produção. |
| LD-S5 | A API mantém o mesmo código de produção: JWT ES256/RS256 por JWKS com `iss` do Supabase local, rate limit pelo `@upstash/ratelimit`, papel `api_runtime` com RLS. |
| LD-S6 | Imagens Docker de terceiros fixadas por digest; Supabase CLI fixado como devDependency. |

## 3. Design técnico

- `local-stack.ts`: funções puras e testadas (config derivada, chaves, segredos, escolha de IP,
  roteamento do portão, bloco do env, leitura do `supabase status`, reescrita do script Lua).
- `local-dev-cli.ts`: liga essas funções ao Docker, ao Supabase CLI e aos processos filhos.
- Celular → portão `<IP>:58780` → Kong `127.0.0.1:58321` (Auth) ou Next `127.0.0.1:3000`
  (`/api`). A API → proxy `127.0.0.1:58379` → ponte `127.0.0.1:58378` → Redis na rede Docker
  `base-app-local`.
- O Metro sobe com `EXPO_NO_REDIRECT_PAGE=1`. Como o `expo-dev-client` está instalado, sem isso o
  QR code aponta para a página intermediária `/_expo/loading`, que a câmera do iPhone abre no
  Safari, e não para `exp://`.
- O proxy Redis remove `allow-key-locking`, flag aceita só pelo Upstash, do shebang dos scripts
  em `EVAL`, `EVAL_RO` e `SCRIPT LOAD`, inclusive em pipeline. `EVALSHA` passa sem mudança e o
  `@upstash/ratelimit` cai em `EVAL` ao receber `NOSCRIPT`.

## 4. Edge cases

| Situação | Comportamento |
|----------|---------------|
| Docker desligado | falha antes de qualquer ação, com instrução |
| `secrets.json` corrompido | gera segredos novos |
| Porta do portão ou do proxy em uso | falha com instrução, sem subir a API |
| Container da ponte publicado em porta antiga | é recriado na porta atual |
| Migration nova | aplicada no próximo `pnpm dev` (`supabase migration up`) |
| `CI` definido no shell | a API recebe as variáveis pelo ambiente do processo |
| Sem IP de rede privada | falha pedindo Wi-Fi ou `LOCAL_DEV_HOST` |
| Body do proxy Redis acima de 1 MiB | 413 |

## 5. Critérios de aceite

- [x] Testes unitários de `local-stack.ts` cobrindo LD-5, LD-3, LD-7, LD-S1, LD-4, a reescrita
  do proxy Redis e a leitura do status sem expor a chave secreta.
- [x] Testes de `platform/env` e `platform/db/runtime` para LD-S4 (aceita local, recusa
  produção, preview, sem `NODE_ENV`, host fora de loopback).
- [x] Teste do registry mobile para HTTP só em `__DEV__` e rede local.
- [x] Execução real em 2026-11-27 (WSL 2 + Docker Desktop, sem `CI`), tudo pelo portão no IP do
  Wi-Fi:
  - health 200;
  - `/api/v1/me` sem token 401;
  - `/auth/v1/admin/users` e `/rest/v1/` 404;
  - OTP com o código lido no Mailpit e `verify` devolvendo JWT ES256;
  - `/api/v1/me` com o token 200;
  - `/api/v1/app-config` 200;
  - bundles de desenvolvimento Android e iOS servidos pelo Metro no IP da rede.
- [ ] Abrir o app no Expo Go de um aparelho físico e concluir o cadastro (validação manual).
