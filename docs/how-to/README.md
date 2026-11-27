# How-to

Receitas para tarefas específicas. Cada uma assume que você já passou pelos
[tutoriais](../tutorials/README.md). O conteúdo é escrito nas ondas de implementação.

| How-to | Quando usar | Relacionado |
|--------|-------------|-------------|
| Publicar nas lojas | Enviar a primeira versão (e as seguintes) à App Store e ao Google Play | [ADR 0012](../adr/0012-ci-cd-and-release.md) |
| Criar a conta de teste para o revisor | Preencher as notas de revisão da Apple e do Google com uma conta que entra sem ler e-mail | [identity-and-auth](../specs/identity-and-auth.md) |
| Preencher Data Safety e privacy manifest | Declarar os dados coletados de forma coerente com os SDKs do app | [ADR 0002](../adr/0002-mobile-expo-react-native.md) |
| Rotacionar segredos | Girar chaves do RevenueCat, Resend, Upstash, `migrator`, token do Expo e `AUDIT_SUBJECT_KEY` | [ADR 0012](../adr/0012-ci-cd-and-release.md) |
| Adicionar uma tabela nova com RLS e pgTAP | Migration, RLS forçado, grants por papel, teste entre usuários, tipos e handler de purga | [ADR 0005](../adr/0005-data-access-sql-migrations-kysely-rls.md) |
| Adicionar uma rota com `defineRoute` | Contrato em `packages/contracts`, rota fina, caso de uso e testes | [ADR 0003](../adr/0003-backend-nextjs-modular-monolith-on-vercel.md), [ADR 0007](../adr/0007-contracts-zod-first-generated-openapi.md) |
| Adicionar um idioma | Novo locale em `product.config.ts` e nos arquivos de i18n, com checagem de chaves | [mobile-app-shell](../specs/mobile-app-shell.md) |
| Aplicar as proteções do GitHub (`github-protections`) | Environments com revisores, rulesets de `main` e de tags, secret scanning, `CODEOWNERS`; rodar `pnpm security:doctor` | [ADR 0012](../adr/0012-ci-cd-and-release.md) |
| Responder a abuso de e-mail (`email-abuse-response`) | Teto `email_sent`, SPF, DKIM e DMARC, reputação do Resend, alertas, reduzir limites, rotacionar o SMTP | [email-abuse-response](email-abuse-response.md), [identity-and-auth](../specs/identity-and-auth.md) |
| Controlar custo e abuso (`cost-guardrails`) | Vercel Firewall, Spend Management, tetos e alertas na Vercel, Upstash, Resend e Supabase | [base-app §3.13](../specs/base-app.md) |
| Rotacionar a chave de assinatura OTA (`rotate-ota-signing-key`) | Troca, perda ou exposição da chave; build novo e `minSupported` | [mobile-app-shell](../specs/mobile-app-shell.md) |
| Publicar o repositório (`publish-repository`) | Varredura do histórico, `SECURITY.md`, relato privado, tags assinadas | [ADR 0012](../adr/0012-ci-cd-and-release.md) |
| Alterar a configuração remota | Mudar versão mínima, modo manutenção e versões dos termos sem release | [app-config](../specs/app-config.md) |

Outros how-to previstos: criar os projetos do Supabase (staging e produção) e aplicar o
`config.toml`; configurar o domínio de e-mail no Resend; configurar o RevenueCat (apps,
produtos, entitlement, oferta, paywall e Test Store); configurar o EAS e a Vercel.
