# Ambiente local com `pnpm dev`

`pnpm dev` sobe, na máquina de quem desenvolve, um backend completo e só seu: Supabase Auth,
Postgres, caixa de e-mail local, Redis, a API Next.js e o Metro para o Expo Go. Não precisa de
conta em Supabase, Upstash, Resend nem Vercel. Só o **iPhone** exige uma conta Expo grátis (veja
abaixo). Para hospedar o produto de verdade, siga
[desenvolver a partir do template](develop-from-template.md).

Tutorial passo a passo para quem está começando: [primeira hora](../tutorials/primeira-hora.md).

## Pré-requisitos

- Node.js 24 (`>=24.22.3 <25`) e pnpm pelo Corepack (`corepack enable`).
- Docker Desktop (ou Docker Engine) **ligado**.
- `pnpm install` na raiz. Ele instala o Supabase CLI fixado no projeto (`supabase` 2.122.1; a
  linha 3.x ainda não publica as portas do banco local no Docker Desktop).
- Expo Go no celular, no mesmo Wi-Fi do computador.
- **iPhone:** o Expo Go do SDK 58 só abre projeto servido pelo computador quando o Expo CLI e o
  Expo Go estão logados na **mesma conta Expo** (grátis, [expo.dev/signup](https://expo.dev/signup)).
  Rode `pnpm expo:login` (ou `pnpm expo:login --sso` se a conta usa Google/GitHub) e entre no
  Expo Go com a mesma conta. Android e simulador não exigem. O `pnpm dev` mostra se o
  computador está logado.

## Comandos

| Comando | O que faz |
|---------|-----------|
| `pnpm dev` | sobe tudo, escreve os `.env.local` e mostra o QR code do Expo Go |
| `Ctrl+C` | para a API, o Metro e o portão de rede; o banco continua ligado |
| `pnpm dev:stop` | desliga o Supabase e o Redis locais (os dados ficam salvos) |
| `pnpm dev:db:reset` | recria o banco local do zero e aplica todas as migrations |
| `pnpm expo:login` | entra na conta Expo no computador (necessário para iPhone) |

Uma migration nova (`supabase/migrations/`) é aplicada no próximo `pnpm dev`
(`supabase migration up`). Se ela já foi aplicada e você a mudou, use `pnpm dev:db:reset`.

## O que `pnpm dev` faz

1. Confere o Docker e o Supabase CLI.
2. Regenera `supabase/config.toml` (`pnpm supabase:config`) e monta uma cópia de trabalho em
   `.local-dev/` (fora do git): config com portas próprias e chave de assinatura ES256 local,
   migrations, templates e testes. O `config.toml` versionado nunca é alterado por isso.
3. Gera, uma vez, segredos locais aleatórios em `.local-dev/secrets.json`: senha do papel
   `api_runtime`, token do Redis e `AUDIT_SUBJECT_KEY`.
4. Sobe o Supabase sem os serviços que a base não usa (Data API, Storage, Realtime, Edge
   Functions, Analytics, pooler) e **sem o Studio**, que dá acesso ao banco inteiro sem senha.
5. Aplica as migrations pendentes, define a senha do `api_runtime` e sobe o Redis, com a ponte
   HTTP compatível com o Upstash (`hiett/serverless-redis-http`, imagem fixada por digest),
   numa rede Docker própria e publicado só em `127.0.0.1`. Entre a API e a ponte fica um proxy
   em `127.0.0.1:58379` que só remove a flag `allow-key-locking` dos scripts Lua do
   `@upstash/ratelimit`: ela existe só no Upstash, e Redis/Valkey recusam o script. O token
   continua sendo checado pela ponte, e a API usa o mesmo código de produção.
6. Escreve o bloco gerenciado no fim de `.env.local` (API) e de `apps/mobile/.env.local` (app).
   O que você escreveu fora do bloco é preservado.
7. Abre o portão de rede no IP do Wi-Fi, inicia a API em `127.0.0.1:3000` e, quando ela
   responde, inicia o Metro em modo Expo Go.

## Endereços

| Serviço | Endereço | Quem acessa |
|---------|----------|-------------|
| Caixa de e-mail (códigos de login) | `http://127.0.0.1:58324` | o computador (veja a nota) |
| Supabase Auth | `http://127.0.0.1:58321` | o computador (veja a nota) |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:58322/postgres` | o computador (veja a nota) |
| API | `http://localhost:3000/api/v1/health` | só o computador |
| Redis (proxy da API → ponte HTTP) | `http://127.0.0.1:58379` → `127.0.0.1:58378` | só o computador |
| Portão de rede | `http://<IP do Wi-Fi>:58780` | o celular |
| Metro (Expo Go) | `exp://<IP do Wi-Fi>:8081` | o celular |

Nota: o Supabase CLI não tem opção de endereço, e o Docker Desktop publica as portas dele em
todas as redes do computador. Por isso a caixa de e-mail, o Auth e o Postgres também respondem
no IP do Wi-Fi enquanto o `pnpm dev` roda. O `pnpm dev` avisa quando isso acontece.

As portas 583xx evitam conflito com outros projetos Supabase locais (543xx).

## Modelo de segurança

- O `pnpm dev` abre de propósito duas portas no Wi-Fi:
  - **portão:** encaminha os endpoints públicos do Supabase Auth (`signup`, `otp`, `verify`,
    `token`, `user`, `logout`, `recover`, `resend`, `reauthenticate`, `settings`, `health`,
    `.well-known`, `factors`, `magiclink`) e `/api/*`. Recusa todo o resto, inclusive
    `/auth/v1/admin` e caminhos com `%`, `\`, `//`, `.` ou `..`;
  - **Metro:** serve o bundle do app, como em qualquer projeto Expo.
- A API autentica toda rota protegida (JWT ES256 verificado por JWKS), como em produção. A API
  e o Redis só aceitam conexões do próprio computador. O Studio não sobe.
- Por limitação do Docker Desktop e do Supabase CLI, também ficam alcançáveis no Wi-Fi enquanto
  o `pnpm dev` roda:
  - o Postgres local, com a senha padrão do Supabase (`postgres`);
  - a caixa de e-mail local, onde alguém na rede poderia ler um código de login local;
  - o gateway do Supabase local, cuja chave secreta local é pública e abre a API administrativa
    do Auth local.

  É a mesma exposição de qualquer projeto Supabase local. Só os dados de desenvolvimento da sua
  máquina são afetados. O `pnpm dev` avisa quando isso acontece.
- As exceções de desenvolvimento valem só fora de produção:
  - **app:** HTTP só em bundle `__DEV__` e só para host local ou de rede privada (ADR 0002);
  - **API:** `SUPABASE_URL` e `UPSTASH_REDIS_REST_URL` em HTTP só em loopback com
    `NODE_ENV` `development`/`test`, e banco sem CA só em loopback, no mesmo modo. Vercel
    preview e produção continuam exigindo HTTPS e o CA do banco.
- Use em rede de confiança (casa, hotspot do seu celular), nunca em Wi-Fi público, e pare com
  `Ctrl+C` e `pnpm dev:stop` quando terminar.

## Problemas comuns

| Sintoma | O que fazer |
|---------|-------------|
| "O Docker não está rodando" | abra o Docker Desktop e espere o ícone ficar estável |
| "porta em uso" ao subir o Supabase | `pnpm dev:stop`; se for outro projeto, `pnpm exec supabase stop --all` |
| Expo Go não abre o projeto / "Could not connect" | celular e computador no mesmo Wi-Fi; no Windows, permita o Node.js em redes privadas no aviso do firewall; Wi-Fi de visitantes isola aparelhos: use o hotspot do celular |
| IP errado no QR code (VPN, várias redes) | `LOCAL_DEV_HOST=192.168.x.x pnpm dev` (PowerShell: `$env:LOCAL_DEV_HOST="192.168.x.x"; pnpm dev`) |
| Expo Go pede atualização ou recusa o SDK | atualize o Expo Go pela loja (o projeto usa o SDK 58) |
| Usa WSL no Windows e o Expo Go dá "The request timed out" | o firewall do Hyper-V bloqueia a entrada no WSL. No PowerShell **como administrador**: `New-NetFirewallHyperVRule -Name "base-app-dev" -DisplayName "base-app pnpm dev" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 8081,58780 -Action Allow` (libera só essas portas, só para o WSL; remova com `Remove-NetFirewallHyperVRule -Name "base-app-dev"`). Exige `networkingMode=mirrored` no `.wslconfig`; sem isso, rode o projeto pelo PowerShell |
| Windows: o celular não conecta e a rede está como "Pública" | no aviso do firewall, o Windows só libera redes privadas. Marque sua rede de casa como **Privada** (Configurações → Rede e Internet → propriedades da rede) ou permita o Node.js também em redes públicas |
| Teste rápido de rede | no navegador do celular, abra `http://<IP do computador>:8081/status`: precisa aparecer `packager-status:running` |
| iPhone: "You need to be signed in to Expo Go and Expo CLI" | `pnpm expo:login` no computador e login no Expo Go com a mesma conta; depois **Try again** (não precisa reiniciar). No WSL, `expo login -b` falha: use usuário e senha ou `--sso` |
| iPhone pergunta sobre "rede local" | permita: é assim que o Expo Go fala com o computador |
| O código não chegou | abra a caixa de e-mail local (`http://127.0.0.1:58324`); o código tem 10 dígitos e vale 5 minutos |
