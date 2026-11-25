# Guardrails de custo para a API

O firewall reduz abuso antes da execução das funções. O `defineRoute` mantém limites por rota
com Upstash; os dois controles se complementam.

## Configurar o limite de borda

No projeto Vercel, abra **Firewall → Configure → Add New Rule** e crie uma regra de Rate Limit:

| Campo | Valor |
|---|---|
| Nome | `api-rate-limit` |
| Condição | `Request Path` começa com `/api/` |
| Chave de contagem | Endereço IP |
| Limite | 300 requisições por 60 segundos |
| Ação após exceder | Responder com HTTP 429 |

Salve primeiro como regra de observação, confira o tráfego no painel e publique depois da revisão
humana. O WAF exige uma ação de continuação para a regra de Rate Limit; escolha o 429. Esse
controle é configurado no Firewall e não entra em `vercel.json` como regra de rate limit.

Para validar os cabeçalhos de uma URL local ou de preview:

```bash
pnpm --filter web headers:check -- https://<host-validado>
```

O comando consulta `/api/v1/health`, `/` e um asset JavaScript em `/_next/static/**`, verificando
HSTS, CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, nonce e `X-Request-Id`.
Preview protegido por login precisa ser acessível ao ambiente que executa o comando.

## Limite dentro da API

Toda rota declara `rateLimit.key`, `limit`, `windowSec` e `onStoreFailure` no contrato. Rotas
autenticadas aplicam o limite principal por usuário e também o teto compartilhado por IP; rotas de
webhook aplicam um limite grosso por IP antes da leitura do corpo e da assinatura. Falha do Redis
segue a política explícita da rota: `closed` responde 503; `open` prossegue e marca
`x-rate-limit-failure: open`.

O contador em memória da função não é usado para aplicar limite: a Vercel pode atender requisições
em instâncias diferentes. Mantenha o limite de borda como proteção de custo e o de Upstash como
política da aplicação.

## Configuração de ambiente da onda 1

`APP_HOST` é obrigatório em todos os ambientes. O script local de desenvolvimento fornece
`localhost:<PORT>` quando o valor está vazio. Em Vercel, configure o host de produção esperado;
preview também reconhece apenas `VERCEL_URL` e `VERCEL_BRANCH_URL` quando `VERCEL_ENV=preview`.

`UPSTASH_REDIS_REST_URL` (HTTPS) e `UPSTASH_REDIS_REST_TOKEN` são a dependência ativa do limite
por rota. Ambos são obrigatórios no boot de preview e produção. No desenvolvimento local, podem
ficar vazios para trabalhar na fundação: rotas `onStoreFailure: 'open'` seguem sem limite e
respondem `x-rate-limit-failure: open`; rotas `closed` respondem 503.

`DATABASE_URL` e `DATABASE_CA_CERT` também são obrigatórios no boot de preview e produção para
a composição do banco da onda 2. O URL deve usar `postgres:` ou `postgresql:` e não pode incluir
`sslmode`; o adaptador aplica o certificado CA e `rejectUnauthorized: true`. Em desenvolvimento
local, a fundação HTTP da onda 1 não abre uma conexão ao banco; preencha esses campos antes de
compor o runtime de dados.

`RESEND_API_KEY` e `RESEND_FROM_EMAIL` só são necessários quando uma feature chamar `EmailSender`;
essa porta ainda não é usada na onda 1. `AUDIT_SUBJECT_KEY` só é necessário para operações que
geram referências pseudônimas de auditoria; W1 não tem rota sensível publicada. `SENTRY_DSN` é
opcional: sem ele a inicialização do SDK é desativada. Os valores permanecem em branco no
`.env.example`; configure credenciais reais pelo ambiente/gerenciador de segredos do projeto.

## Referências

- [Vercel WAF Custom Rules](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules)
- [Vercel WAF Rate Limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)
- [Vercel Firewall Rule Configuration](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration)
