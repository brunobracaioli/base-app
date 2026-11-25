# ADR 0003 — API como monolito modular em Next.js na Vercel

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

A API precisa verificar o JWT do Supabase, consultar o RevenueCat, orquestrar a exclusão de
conta, aplicar rate limit e cotas, e servir o site institucional (termos, privacidade e a
página de exclusão exigida pelo Google Play). A produção escolhida é Vercel + Supabase.

Um backend organizado por camada técnica (`routes/`, `utils/`, `models/`) tende a levar regra
de negócio para dentro das rotas e a misturar assuntos. O template precisa ensinar o
contrário.

## Decisão

1. **Uma aplicação Next.js (App Router)** em `apps/web` serve o site e a API em `/api/v1`. Os
   route handlers são adaptadores finos.
2. **Monolito modular por bounded context** em `apps/web/src/modules/<context>/`:
   - `domain/`: agregados, value objects, eventos, portas. Sem imports de fora.
   - `features/<slice>/`: um caso de uso por pasta, com `application/` (handler de command ou
     query), `presentation/` (`defineRoute` e mapeamento) e testes.
   - `infrastructure/`: adaptadores das portas (Kysely, RevenueCat, e-mail).
   - `index.ts`: única superfície pública do contexto.

   É uma adaptação da Vertical Slice Architecture para contextos em que vários casos de uso
   compartilham o mesmo agregado: o domínio fica no nível do contexto, a fatia fica no caso de
   uso.
3. Contextos do base-app: `identity`, `billing`, `privacy`, `app-config` e `examples`.
4. **`platform/`** guarda o que é transversal: pipeline HTTP (`defineRoute`), autenticação, rate
   limit, logger, acesso a banco, env, barramento de eventos, e-mail e `kernel` (Result, IDs,
   relógio).
5. **Comunicação entre contextos** só de duas formas: consulta ou comando pelo `index.ts` do
   outro contexto (grafo acíclico) ou evento de domínio declarado em `platform/events`. O
   barramento é em processo, síncrono e dentro da mesma transação; handlers são idempotentes.
6. **Fronteiras checadas no CI** com dependency-cruiser (regras na spec principal §3.5).
7. **Portas substituíveis e composição:** `EntitlementsReader`, `AccountDeletionPolicy`,
   `EmailSender` e `AuthorizationPolicies` podem ser trocadas por extensões (ADR 0013). A
   composição dos módulos do núcleo e das extensões fica em `composition/`.
8. **Rotas:** toda rota usa `defineRoute`, com `auth` obrigatório e sem valor padrão. A ordem
   fixa é gate de versão, autenticação, rate limit, autorização, validação, idempotência e caso
   de uso.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Supabase Edge Functions (Deno) como backend | Divide o código entre Deno e Node, sem o mesmo tooling de testes e fronteiras; a regra de negócio se espalha em funções soltas |
| Hono ou Fastify como serviço separado | API mais enxuta, mas exigiria outro projeto para o site. Fica como caminho de extração se a API crescer |
| Lógica no banco (SQL e RLS fazendo regra de negócio) | Difícil de testar e evoluir; o banco fica com integridade e isolamento, a regra fica no domínio |

## Consequências

- **Custo e abuso (G12):** Vercel, Upstash, Resend e Supabase cobram por uso. Uma regra de rate
  limit do Vercel Firewall em `/api` (300 req/min por IP) barra a inundação antes da função, e o
  `defineRoute` soma o teto por IP nas rotas autenticadas; os tetos de gasto e os alertas estão em
  base-app.md §3.13.
- **Cabeçalhos em três camadas (G13):** `next.config` (estáticos e CSP sem script), `defineRoute`
  (API) e middleware (CSP com nonce). A página que segura sessão se recusa a renderizar sem o
  nonce, e um Deployment Check confere os cabeçalhos antes da promoção.
- Funções serverless não guardam estado em memória entre requisições, além de caches (JWKS,
  configuração). Rate limit e cotas usam o Upstash Redis.
- Não há agendador em processo nem funções agendadas na Vercel: a manutenção roda no Postgres
  (ADR 0008).
- Extrair um contexto para serviço próprio exige trocar o barramento em processo por outbox +
  fila e as chamadas de `index.ts` por HTTP autenticado. As fronteiras já estão no lugar.
- Next.js como API traz peso que um framework só de API não teria; aceito pela simplicidade de
  um projeto Vercel só.

## Spike S-TM-2 — cabeçalhos e matcher

Em 2026-11-25, a versão estável mais recente no npm era `next@16.4.6` (compatível com Node 24),
com `react@19.3.1` e `react-dom@19.3.1`. Um app temporário executado pelo runtime real do Next
recebeu requisições HTTP em `GET /api/health`, `/`, `/w1-spike.txt` e
`/_next/static/development/_buildManifest.js`.

- Com `proxy.ts` e `matcher: '/:path*'`, os quatro caminhos executaram o proxy e receberam o
  cabeçalho dinâmico de CSP com nonce.
- Sem `proxy.ts`, `next.config.headers()` com `source: '/:path*'` ainda aplicou os cabeçalhos
  estáticos, inclusive CSP, aos quatro caminhos.
- Com ambos ativos, a CSP definida no proxy substituiu a CSP estática (uma política na resposta),
  e os demais cabeçalhos de `next.config` permaneceram.

**Decisão confirmada:** manter as três camadas deste ADR, usar `next.config` para cabeçalhos
estáticos independentes, e usar o `proxy.ts` do Next 16 com matcher abrangente para conferência
de host e CSP com nonce. A especificação continuará chamando o componente de borda de middleware
como papel arquitetural; o arquivo/runtime executável é `src/proxy.ts` nesta versão do Next.

**Limite da evidência:** esta foi uma verificação HTTP no servidor local de desenvolvimento. Ela
não valida navegador, build de produção, preview hospedado ou Deployment Check.

### S-TM-2 — requisições de caminho bruto

Uma segunda verificação usou sockets TCP para enviar request-targets sem normalização do cliente
HTTP (`//painel`, `/foo\\bar`, `/%2e`, `/%2e%2e/painel`, `/%2f` e `/%5c`). No runtime 16.4.6:

- `//painel` e `/foo\\bar` viraram respostas `308` com `Location` antes de `proxy.ts`; a resposta
  não recebeu nem os headers estáticos de `next.config`.
- `/%2e` chegou ao proxy como `/` e `/%2e%2e/painel` como `/painel`, mesmo com
  `skipProxyUrlNormalize: true` e `skipTrailingSlashRedirect: true`.
- Os caminhos com `%2f` e `%5c` chegaram ao proxy ainda codificados.

**Decisão do dono (2026-11-25):** documentar o comportamento pré-Proxy do Next 16.4.6, sem adicionar
um ingress anterior ao Next. O checker aceita somente os redirects 308 observados cujo `Location`
seja o destino absoluto esperado na mesma origem, sem autoridade/query/fragmento; em seguida envia
uma nova requisição ao destino com o mesmo `Host` para reaplicar o isolamento de host e prefixo.
Headers são obrigatórios em respostas do Proxy e da aplicação. A resposta 308 pré-Proxy pode não
conter esses headers; a exceção não cobre redirects arbitrários.

### CSP com nonce e renderização dinâmica

O nonce do CSP só pode corresponder aos scripts HTML quando o documento é renderizado por
requisição. O layout raiz chama `headers()` para impedir prerenderização estática do HTML; o build
local passou a reportar `ƒ /`. No servidor otimizado local, `headers:check` confirmou que o nonce
da resposta CSP corresponde ao nonce dos scripts inline e que os headers estão presentes em
health, página e asset estático. Isso é teste HTTP local; não substitui navegador nem preview
hospedado.

### Evidência do checker de request-target bruto (2026-11-25)

`apps/web/scripts/check-raw-edge-requests.mjs` envia request-targets com TCP para uma origem
HTTP de loopback, sem deixar o cliente normalizar o caminho. O JSON distingue
`pre-proxy-normalization`, `proxy-rejection` e `proxy-forwarded`, inclui `Location` e
`Cache-Control`, e informa a presença de cada header de segurança, do nonce CSP e do request ID sem
imprimir os valores dinâmicos. O checker segue os redirects 308 somente quando `Location` é o
caminho relativo exato esperado na mesma origem, e faz a segunda requisição manualmente com o mesmo
`Host`. Headers de segurança são obrigatórios nas respostas do Proxy/aplicação; o 308 pré-Proxy é
registrado como exceção. A checagem de prefixo só recebe aprovação completa quando o comando
informa um host e prefixo de extensão registrados; sem eles o resultado é `incomplete` e o código
de saída é 1.

No build otimizado local de `next@16.4.6`, sob Node `24.22.3`, `CI=1` e ambiente sem credenciais,
o servidor do template com `edgeExtensions` vazio foi exercitado em `127.0.0.1:48621`. Health no
`APP_HOST` respondeu 200 com nonce, request ID e os cinco headers; host desconhecido respondeu
`edge.not_found` 404 com os cinco headers. O checker registrou `acceptanceStatus: incomplete` e
código 1 porque a lista de extensões está vazia e nenhum teste de prefixo poderia ser alegado.

Na mesma execução base, `//panel` produziu 308 pré-Proxy com `Location: /panel`, e `/foo\\bar`
produziu 308 com `Location: /foo/bar`. Os dois destinos exatos foram reenviados com o mesmo
`APP_HOST` e responderam 404 de rota do Next com os cinco headers e CSP nonce. `//api/v1/health`
no host desconhecido produziu `Location: /api/v1/health`; a segunda requisição, mantendo esse host,
foi rejeitada com `edge.not_found` 404 e headers. `Location` não aceito pelo checker se contiver
autoridade, query, fragmento, barra invertida ou diferir do caminho esperado. As três respostas 308
originais não continham `X-Request-Id` nem os cinco headers; o resultado registrou esse fato como
comportamento pré-Proxy, sem dispensar headers no destino.

Os request-targets `/%2e`, `/%2e%2e/panel` e `/a/../panel` chegaram ao Proxy como `/`, `/panel` e
`/panel`; os destinos de app responderam 200 ou 404 de rota com headers. `/%2e%2e/api/v1/health`
no host app chegou ao health e respondeu 200; o mesmo destino no host desconhecido foi rejeitado
com 404. `/%2f` e `/%5c` permaneceram codificados e foram rejeitados pelo Proxy com `edge.not_found`
404 e headers.

Para testar prefixos, um build otimizado temporário registrou uma extensão de fixture
(`fixture.invalid:48622`, `/fixture-panel`); o registro vazio do template não foi alterado. O
checker foi executado com `--extension-host fixture.invalid:48622 --extension-prefix /fixture-panel`
contra esse servidor e terminou com `acceptanceStatus: passed`, código 0. Treze verificações de
prefixo/destino passaram: prefixo direto, segmentos `..` e `a/..`, diferença de caixa, host app,
host desconhecido e host de extensão; redirects pré-Proxy sem headers só passaram após `Location`
exato e revalidação do destino com o mesmo host. No host de extensão as rotas de fixture foram
encaminhadas com nonce; no host app, host desconhecido e fora do prefixo foram negadas com
`edge.not_found`.
Este resultado usa configuração de fixture temporária e não afirma que o template tenha extensão
ativa.

O checker encerra com `incomplete`/código 1 quando faltam os argumentos de extensão; a opção
omitida não transforma cobertura ausente em aprovação. Estes são testes HTTP locais de produção,
sem credenciais externas; não validam navegador, ingress anterior ao Next ou preview hospedado.
