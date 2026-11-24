# Documentação do base-app

Template gratuito de app mobile (iOS e Android) com login por e-mail, assinatura pelo
RevenueCat, exclusão de conta e conformidade com as lojas. Esta documentação segue o modelo
[Diátaxis](https://diataxis.fr): cada pasta responde a um tipo de pergunta.

## Por onde começar

| Quero... | Vá para |
|----------|---------|
| Aprender fazendo, do clone ao primeiro build | [tutorials/](tutorials/README.md) |
| Resolver um problema específico | [how-to/](how-to/README.md) |
| Consultar API, variáveis e configuração | [reference/](reference/README.md) |
| Entender por que é assim | [explanation/](explanation/why-this-architecture.md) |

## Mapa da documentação

| Pasta | Tipo Diátaxis | Conteúdo |
|-------|---------------|----------|
| [tutorials/](tutorials/README.md) | Tutorial | Aprendizado guiado para alunos |
| [how-to/](how-to/README.md) | How-to | Receitas para tarefas específicas |
| [reference/](reference/README.md) | Referência | OpenAPI gerado, variáveis de ambiente, `product.config.ts` |
| [explanation/](explanation/why-this-architecture.md) | Explicação | Contexto e racional das decisões |

## Documentos de engenharia

| Documento | O que é |
|-----------|---------|
| [specs/base-app.md](specs/base-app.md) | Spec principal: escopo, arquitetura, pontos de extensão |
| [specs/identity-and-auth.md](specs/identity-and-auth.md) | Login por e-mail, sessão, perfil |
| [specs/billing.md](specs/billing.md) | Assinatura e paywall |
| [specs/account-lifecycle-and-privacy.md](specs/account-lifecycle-and-privacy.md) | Exclusão de conta, termos, exportação (LGPD) |
| [specs/app-config.md](specs/app-config.md) | Atualização obrigatória e manutenção |
| [specs/mobile-app-shell.md](specs/mobile-app-shell.md) | Casca do app mobile |
| [plan/implementation-waves.md](plan/implementation-waves.md) | Plano de ondas de implementação |
| [security/threats/base-app.md](security/threats/base-app.md) | Threat model (STRIDE) |

## Decisões de arquitetura (ADRs)

Formato Michael Nygard. Todos com status `proposed` até a revisão final.

| ADR | Decisão |
|-----|---------|
| [0001](adr/0001-monorepo-pnpm-turborepo.md) | Monorepo com pnpm e Turborepo |
| [0002](adr/0002-mobile-expo-react-native.md) | App com React Native e Expo |
| [0003](adr/0003-backend-nextjs-modular-monolith-on-vercel.md) | API como monolito modular em Next.js na Vercel |
| [0004](adr/0004-supabase-auth-and-jwt-verification.md) | Supabase Auth e verificação do JWT por JWKS |
| [0005](adr/0005-data-access-sql-migrations-kysely-rls.md) | Acesso a dados: SQL, Kysely, RLS, Data API fechada |
| [0006](adr/0006-revenuecat-simple-entitlement-check.md) | RevenueCat: conferência simples de entitlement |
| [0007](adr/0007-contracts-zod-first-generated-openapi.md) | Contratos em Zod com OpenAPI gerado |
| [0008](adr/0008-maintenance-jobs-pg-cron.md) | Rotinas de manutenção com `pg_cron` |
| [0009](adr/0009-observability.md) | Observabilidade |
| [0010](adr/0010-template-customization-product-config.md) | Personalização por `product.config.ts` |
| [0011](adr/0011-b2c-user-as-tenant.md) | Modelo B2C: o usuário é o tenant |
| [0012](adr/0012-ci-cd-and-release.md) | CI/CD e release |
| [0013](adr/0013-extensible-core.md) | Núcleo extensível |

## Regras desta documentação

- Spec e contrato mudam no mesmo PR da implementação.
- Toda decisão estrutural vira ADR antes do código. ADR aceito não é editado: é substituído por
  outro, com status `superseded`.
- Documentação em pt-BR; código, identificadores, nomes de API e commits em inglês.
- Nenhum segredo, e-mail real ou dado pessoal em documentação, exemplos ou testes.
