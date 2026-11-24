# ADR 0006 — RevenueCat: conferência simples de entitlement

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O app vende assinatura pelas lojas, e o servidor precisa decidir o acesso pago sem confiar no
app (um app adulterado diria que pagou). O RevenueCat cuida de recibos, validação nas lojas e
paywalls, e é a fonte da verdade de quem pagou.

Mantemos uma cópia das assinaturas no nosso banco (alimentada por webhook) só quando há motivo
forte, porque exige: endpoint de webhook autenticado, fila, jobs de reconciliação, tabelas, RLS,
purga e alertas. Para um template de alunos isso é complexidade demais; um app que só precisa
saber "este usuário tem o entitlement `pro` agora?" não precisa disso.

## Decisão

- O app usa o SDK do RevenueCat (`react-native-purchases` e `-ui`) para paywall, compra e
  restauração. Chama `Purchases.logIn(user_id)` quando há sessão; **o `user_id` do Supabase é o
  `appUserID`**. O app nunca compra com ID anônimo do RevenueCat. Ao sair, chama
  `Purchases.logOut()` (que deixa o SDK anônimo) e trata o erro que o SDK devolve se o usuário já
  for anônimo; o paywall só abre com sessão.
- A API **consulta a API REST v2 do RevenueCat** com a chave secreta (só no servidor, com a
  permissão mínima: ler clientes e excluir cliente) e decide o acesso por entitlements ativos.
- A resposta (inclusive a vazia) é guardada **por 60 s** no Upstash Redis, por usuário
  (`billing.cacheTtlSec` em `product.config.ts`), assinada com HMAC e conferida contra o TTL na
  leitura.
- **Orçamento global** de chamadas ao RevenueCat (240/min, com 60/min reservadas a `refresh` e
  exclusão) e disjuntor compartilhado no Redis (billing.md §3.2).
- `POST /v1/billing/refresh` invalida o cache do usuário e consulta de novo. O app o chama
  depois de comprar ou restaurar; o acesso pago passa a valer no servidor em até 5 s (RF-07).
- **Sem webhook, sem tabelas, sem jobs** no base-app. O contexto `billing` não tem schema.
- **Falha fechada:** sem cache válido e com o RevenueCat fora, ações pagas respondem 503
  `billing.unavailable`. Nunca liberam sem confirmar. Timeout de 5 s; retry com backoff e jitter
  só em GET.
- A resposta do RevenueCat é validada com Zod (é dado de terceiro). Um entitlement desconhecido
  em `product.config.ts` é ignorado.
- Acesso pela porta `EntitlementsReader` (`hasEntitlement`, `listActiveEntitlements`). Versões
  derivadas podem trocar a implementação (ver Alternativas).
- A exclusão de conta apaga o cliente no RevenueCat (404 conta como sucesso), no handler de
  `AccountPurgeRequested` do `billing`.
- Preços, ofertas e textos do paywall ficam no RevenueCat e nas lojas, nunca no código.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Webhook do RevenueCat com cópia das assinaturas no banco | Rejeitada no base-app por complexidade e por exigir jobs (reconciliação). **É a escolha de versões derivadas**, que trocam a porta `EntitlementsReader` por uma que lê o espelho, registram a rota do webhook com `auth: { kind: 'webhook', verifier }` e criam schema e jobs próprios |
| Conferência só no cliente (`CustomerInfo` decide) | Rejeitada: insegura. Qualquer ação com custo ou valor que o servidor executa precisa ser decidida no servidor |
| Consultar o RevenueCat a cada requisição, sem cache | Latência e limites de taxa da API do RevenueCat; o cache de 60 s corta a maior parte das chamadas |

## Consequências

- **Latência e limites.** A primeira checagem de cada janela de 60 s paga uma ida ao RevenueCat
  (p95 maior). Os limites de taxa da API v2 valem para o projeto; o rate limit por usuário e o
  cache os respeitam. O RevenueCat fora do ar bloqueia ações pagas sem cache válido.
- **Janela de inconsistência.** Sem `refresh`, uma compra, um cancelamento ou um reembolso só
  aparece no servidor em até 60 s. Aceito; revogação por reembolso também sobe em até 60 s.
- **Compras sandbox são aceitas em qualquer ambiente**, porque a revisão da Apple testa compras
  de sandbox contra o backend de produção. O RevenueCat Test Store é recusado em produção, e
  cada ambiente usa um projeto RevenueCat próprio.
- **`user_id` como `appUserID`.** Se o cliente RevenueCat existir sob outro ID (ex.: anônimo),
  o servidor não o enxerga. Por isso o app faz `logIn` antes da compra e o paywall só abre com
  sessão; o `logOut` deixa o SDK anônimo, o que é inofensivo porque nada é comprado sem sessão.
- Sem tabela de assinaturas, não há histórico local nem relatórios; análise fica no painel do
  RevenueCat.
- Trusted Entitlements ligado no SDK. Feature premium que roda só no cliente é considerada
  desprotegida e o template documenta isso.
- Spike S-BI-1 (onda 7): endpoints, permissões mínimas e limites da API v2.
