# ADR 0014 — `supabase/config.toml` gerado

- **Status:** proposed
- **Data:** 2026-11-24
- **CLI de referência da onda 2:** Supabase CLI 3.4.0 (pin verificado em 2026-11-25)

## Contexto

O Supabase CLI lê um único `supabase/config.toml` (Auth, rate limits, SMTP, Data API). Numa
versão derivada, uma extensão precisa mudar essa configuração: ligar um provedor de login
social, um CAPTCHA, ou ajustar um limite. Se ela editar o `config.toml` do núcleo, todo
`git merge upstream/main` que toque o arquivo gera conflito, e a regra de ADR 0013 ("só editar
a lista de arquivos permitidos") quebra.

## Decisão

- O núcleo versiona `supabase/config.base.toml` (a configuração do núcleo, fonte editável) e a
  pasta `supabase/config.d/` (vazia, com `.gitkeep`).
- `pnpm supabase:config` (em `packages/tooling`) gera `supabase/config.toml`: mescla
  profundamente `config.base.toml` e os fragmentos `config.d/*.toml`, em ordem alfabética. O
  fragmento vence; o gerador lista no cabeçalho as chaves do núcleo que foram sobrescritas. O
  arquivo começa com o aviso "gerado; não edite".
- Uma extensão traz o próprio fragmento como **arquivo novo** (ex.:
  `config.d/20-social-auth.toml`). Segredos só com `env(...)`, nunca o valor.
- O `config.toml` commitado é o gerado. O CI roda o gerador, valida o TOML pelo CLI pinado e
  falha se houver diferença. Em conflito de merge, o arquivo é regenerado, nunca resolvido à mão
  (spec §3.4.3).
- Quem altera a configuração do núcleo edita `config.base.toml` e regenera.
- **Fonte efetiva única:** o gerador e `supabase:config:check` recusam a existência
  de `supabase/config.json` ou `supabase/config.jsonc`. Versões atuais do CLI aceitam
  esses formatos com precedência sobre TOML; permitir um deles tornaria possível
  executar configuração diferente da validada. Esse endurecimento foi aprovado
  pelo dono em 2026-11-24. O formato versionado continua TOML.
- **Invariantes de segurança (G32).** `pnpm supabase:config:check` roda sobre o `config.toml`
  gerado, no CI do núcleo e no de toda versão derivada (tabela em identity-and-auth.md §3.7:
  `api.enabled = false`, `jwt_expiry ≤ 900`, `secure_password_change`, `double_confirm_changes`,
  OTP de 8 dígitos e ≤ 600 s, limites por IP e `email_sent` não maiores que os do núcleo, SMTP
  por `env()`, superfícies desligadas). Um fragmento que sobrescreva chave protegida sem o
  marcador `# allow-override: <chave> <motivo>` faz o gerador falhar; com o marcador, a exceção
  aparece no cabeçalho e o teste a aceita só se o valor continuar dentro da regra.
  `auth.enable_anonymous_sign_ins` e `auth.enable_manual_linking` aceitam o marcador com uma
  invariante extra: valor `true` exige CAPTCHA ligado no `config.toml` gerado, e com CAPTCHA
  desligado o check falha mesmo com o marcador. O modo visitante só liga depois do CAPTCHA.
- **Compatibilidade com CLI 3.4.0.** O formato TOML continua aceito, embora `supabase init` passe
  a gerar JSONC. A fonte `config.base.toml` usa os nomes atuais `auth.email.enabled`,
  `auth.sms.enabled` e `auth.external.slack_oidc`; não contém `auth.email.enable_signup`,
  `auth.sms.enable_signup`, `auth.external.slack` nem `[auth.saml]`, que a validação 3.4.0 marca
  como depreciados ou removidos. CAPTCHA desligado não inclui `provider` ou `secret`; quando uma
  extensão o habilitar, o provedor é `hcaptcha` ou `turnstile` e o segredo permanece em `env(...)`.
- **Limite do `config push` / S-TM-4.** A implementação 3.4.0 é diff-first e escreve somente
  valores declarados para os quais há encoder hospedado; valores locais e propriedades sem
  encoder não são prova de configuração no painel. `db.pooler.enabled`, portas locais,
  `[local_smtp]` e `[realtime]` não têm contraparte hospedada. `[auth.saml]` não existe no schema
  TOML dessa versão. O código-fonte do CLI é evidência de capacidade declarada, não de aplicação
  em um projeto hospedado. S-TM-4 permanece pendente porque não foi disponibilizado um alvo
  autorizado; antes da release, validar o diff em um projeto existente e registrar os controles
  que exigem conferência manual no painel. Nunca usar `--yes` como substituto de autorização do
  operador.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| A extensão edita o `config.toml` | Conflito de merge a cada mudança do núcleo no arquivo |
| Só variáveis de ambiente (`env(...)`) | Cobre valores, não a estrutura (ligar provedor, mudar tabela de limites) |
| Não versionar o `config.toml` (gerar só no CI) | `supabase start` local e a revisão em PR perdem o arquivo que realmente vale; o drift fica invisível |
| Script de patch aplicado no deploy | Esconde a configuração real e dificulta a revisão |

## Consequências

- O `config.toml` passa a ser arquivo gerado (junto com `openapi.yaml` e os tipos Kysely):
  nunca editado à mão.
- A configuração de uma extensão fica num arquivo próprio, revisável no PR dela, sem tocar no
  núcleo; uma chave sobrescrita aparece no cabeçalho do gerado.
- O gerador precisa de teste (mescla profunda, ordem, sobrescrita listada, fragmento inválido
  falha) e de uma verificação de que um fragmento não carrega segredo literal.
- O spike S-TM-4 não foi validado contra um projeto hospedado; a versão base registra explicitamente
  a porta de autorização e os controles locais/painel, sem afirmar que a configuração remota foi
  aplicada.
- O ponto de extensão é mais um contrato do núcleo: mudar o formato do cabeçalho ou a regra de
  precedência é mudança incompatível (ADR 0013).
