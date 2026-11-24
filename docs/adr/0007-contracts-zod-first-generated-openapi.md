# ADR 0007 — Contratos em Zod com OpenAPI gerado

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O método pede API-First: contrato versionado antes da implementação. App e API são TypeScript
e precisam validar os mesmos formatos em tempo de execução (o app valida as respostas; a API
valida as requisições). Escrever OpenAPI à mão e Zod à mão cria duas fontes que divergem.

## Decisão

- A fonte do contrato é `packages/contracts`: schemas Zod de request, response e erro, mais a
  tabela de endpoints (método, path, segurança, rate limit, schemas).
- O OpenAPI 3.1 é **gerado** desses schemas em `docs/reference/openapi.yaml` (`pnpm
  contracts:openapi`) e commitado. O CI gera de novo e falha se houver diferença (drift).
- Toda rota pública declara `security: []` no contrato. Um teste confere que as rotas públicas
  do código são exatamente as do contrato (hoje `GET /v1/health` e `GET /v1/app-config`).
- Schemas de body são `.strict()` (campo desconhecido é 400), imposto por regra de lint em
  `packages/contracts`.
- Exceção `.strip()` (payload de emissor autenticado, em `packages/contracts/src/**/webhooks/**`):
  um teste estático só aceita esses schemas em rotas com `auth.kind: 'webhook'` e nunca como
  `input.body` de rota de usuário.
- Cada rota declara no contrato como se comporta com o Redis fora (`x-rate-limit-failure:
  closed | open`) e traz o `ipLimit`; rota sem isso reprova o teste do contrato.
- Erros seguem `application/problem+json` (RFC 9457), com `code` estável.
- O client do app é derivado da mesma tabela de endpoints, com tipos inferidos.
- **Fluxo API-First:** numa onda nova, o primeiro commit altera `packages/contracts` e o YAML
  gerado; o handler vem depois. A revisão do contrato acontece no diff do YAML.
- Mudança incompatível cria `/v2` para o endpoint afetado e registra a nota de compatibilidade
  no próprio contrato.
- Extensões acrescentam schemas e rotas em `packages/contracts/src/extensions/index.ts`; a
  geração do OpenAPI os inclui (ADR 0013).

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| OpenAPI escrito à mão como fonte, tipos por `openapi-typescript` | Os tipos sairiam do YAML, mas a validação em runtime precisaria de outro gerador para Zod |
| tRPC ou ts-rest sem OpenAPI | Acopla o app ao framework e não gera documentação consumível por terceiros |

## Consequências

- O gerador de OpenAPI a partir de Zod precisa suportar a versão do Zod usada; a onda 0 escolhe
  a biblioteca (ou o `toJSONSchema` nativo do Zod 4) e trava a versão.
  Escolha da onda 0: Zod 4 com `toJSONSchema` nativo e serialização YAML
  determinística; não há uma segunda biblioteca de conversão do contrato.
- Revisores olham o diff do YAML gerado nas PRs que mudam contratos.
- Numa versão derivada, `docs/reference/openapi.yaml` inclui as rotas das extensões e por isso
  difere do base-app. É arquivo gerado: num conflito de merge, descarta-se o conteúdo e roda-se
  `pnpm contracts:openapi` (ADR 0013).
