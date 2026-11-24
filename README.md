# base-app

Template gratuito para criar apps mobile (iOS e Android) com arquitetura profissional: login,
assinatura, exclusão de conta e as exigências da App Store e do Google Play já resolvidos,
com testes e CI desde o primeiro commit.

> **Status:** em especificação. O código é construído onda a onda, seguindo
> [docs/plan/implementation-waves.md](docs/plan/implementation-waves.md).

## O que vem pronto

- Login por e-mail com código ou com senha, redefinição de senha, sessão criptografada no
  aparelho.
- Assinatura pelo RevenueCat: paywall remoto, compra, restauração e gerenciamento. O servidor
  confere o acesso pago, sem confiar no app.
- Exclusão de conta no app e pela web, e exportação dos dados (LGPD).
- Atualização obrigatória e modo manutenção sem novo release.
- Português, inglês e espanhol; tema claro e escuro.
- Uma feature de exemplo protegida por assinatura, para copiar e adaptar.

## Stack

Expo (React Native) · Next.js na Vercel · Supabase (Auth + Postgres) · RevenueCat ·
Upstash Redis · Resend · TypeScript strict · pnpm + Turborepo.

## Por onde começar

| Quero... | Leia |
|----------|------|
| Entender o que o template faz e como | [docs/specs/base-app.md](docs/specs/base-app.md) |
| Entender por que a arquitetura é assim | [docs/explanation/](docs/explanation/) e [docs/adr/](docs/adr/) |
| Rodar e publicar meu app | [docs/tutorials/](docs/tutorials/) |
| Resolver uma tarefa específica | [docs/how-to/](docs/how-to/) |
| Usar um agente de código (Codex, Claude Code) | [AGENTS.md](AGENTS.md) |

## Licença

[MIT](LICENSE).
