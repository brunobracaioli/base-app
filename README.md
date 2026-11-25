# base-app

Template gratuito em construção para criar apps mobile (iOS e Android), com login,
assinatura, exclusão de conta e os requisitos das lojas, seguindo arquitetura modular,
testes e CI desde a fundação.

> **Status:** fundação da onda 0 implementada e validada localmente; pendências e
> evidências em [NOTES.md](NOTES.md) e no [relatório da onda 0](docs/plan/wave-0-execution.md).
> O app e a API serão implementados nas próximas ondas do
> [plano](docs/plan/implementation-waves.md).

## Escopo planejado do template

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

Para verificar a fundação, prepare as ferramentas fixadas no
[guia do gate local/KVM](docs/how-to/local-quality-gate.md). Com nvm e Corepack disponíveis:

```bash
nvm install
nvm use
corepack enable
pnpm ci:local
```

GitHub Actions não é usado. O gate gera recibo por commit/tree e os testes não
exigem credenciais. O `.env.example` contém somente nomes
de variáveis, sem valores. A configuração e a entrega de e-mail do Supabase serão
validadas na onda 2; a configuração gerada atual não comprova um serviço em operação.

| Quero... | Leia |
|----------|------|
| Entender o que o template faz e como | [docs/specs/base-app.md](docs/specs/base-app.md) |
| Entender por que a arquitetura é assim | [docs/explanation/](docs/explanation/) e [docs/adr/](docs/adr/) |
| Rodar e publicar meu app | [docs/tutorials/](docs/tutorials/) |
| Resolver uma tarefa específica | [docs/how-to/](docs/how-to/) |
| Usar um agente de código (Codex, Claude Code) | [AGENTS.md](AGENTS.md) |

## Licença

[MIT](LICENSE).
