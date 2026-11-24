# ADR 0010 — Personalização do template por `product.config.ts`

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O template gera vários apps. Se nome, IDs de pacote, entitlements e métodos de login estiverem
espalhados pelo código, cada app novo exige caça a strings, e as atualizações do template viram
conflitos de merge.

## Decisão

- Um único arquivo, `packages/config/src/product.config.ts`, descreve o produto: `slug`,
  `displayName`, bundle ID (iOS) e package (Android), `scheme`, origem web, idiomas, métodos de
  login, `recentAuthMaxAgeSec`, entitlements e `cacheTtlSec` do billing, cotas e caminhos dos
  documentos legais.
- Validado por Zod no build do app (`app.config.ts`) e no boot da API. Valor inválido para o
  build e impede a API de subir, com a mensagem do Zod.
- **Limites no schema (G23):** `auth.recentAuthMaxAgeSec` de 60 a 900, `billing.cacheTtlSec` de
  15 a 300, `perDay` e `globalPerDay` de 1 a 1 000 000.
- **Asserção de ambiente (G22):** o bloco `environments` lista, por ambiente, a URL do Supabase e
  o projeto do RevenueCat (valores públicos). No boot, `production` exige os de produção e
  `preview` recusa os de produção.
- **Segredos nunca entram nele.** Ficam em variáveis de ambiente validadas no boot por
  `platform/env`.
- **Bloco `extensions`:** `product.config.ts` tem a chave `extensions` (vazia no base-app),
  validada por `extensionConfigSchema`, exportado por `packages/config/src/extensions.ts`. O
  mesmo arquivo exporta `extensionAuthMethods`, que acrescenta valores válidos a
  `auth.methods`. Os dois começam vazios, de modo que o base-app aceita só `extensions: {}`. A
  extensão é dona do schema do próprio bloco; o núcleo não conhece o conteúdo.
- `pnpm bootstrap:init` pergunta nome, slug, bundle ID, package e domínio; reescreve o
  `product.config.ts`, os placeholders de `supabase/config.base.toml` (o `config.toml` é gerado, ADR 0014) e os `.env.example`; e remove a
  feature de exemplo (`examples/premium-action`) se o aluno pedir.
- Um app criado do template acompanha o base-app com `git remote add upstream` e `git merge
  upstream/main` periódico. Partes do núcleo não são editadas no app; a personalização vai para
  o config, para os pontos de extensão e para pastas de produto (ADR 0013).

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Gerador de projeto (CLI estilo `create-*`) | Mais polido, mas atualizar apps já gerados vira outro problema. Um repositório template com merge é mais simples de manter |
| Variáveis de ambiente para tudo | Nome do app e bundle ID são necessários em build, não em runtime, e precisam de validação de tipo |

## Consequências

- O schema do `product.config.ts` é contrato do template: mudança incompatível pede nota no
  CHANGELOG.
- `product.config.ts` é um dos arquivos que uma versão derivada pode editar (ADR 0013): o
  conflito de merge nele é resolvido à mão.
- O `bootstrap:init` precisa ser idempotente e coberto por teste, porque é o primeiro contato
  do aluno com o template.
