# Verificação das ondas 1, 2 e 3

Estado em 2026-11-25: implementação parcial, sem ✅ nas três ondas. A `main`
continua no merge da onda 0 (`cda886d`). Nenhum novo push, PR ou deploy foi feito.

| Onda | Branch | Estado |
| --- | --- | --- |
| 1 | `feat/w1-api-platform` | `cf096e0`; código e gates locais aprovados, aceite de caminhos pré-Proxy pendente |
| 2 | `feat/w2-supabase-baseline` | Base local W1; reset, código, tipos e pooler TLS validados; pgTAP reprova a baseline de segurança |
| 3 | `feat/w3-mobile-shell` | `8949ee6`, `ef5e559`, `861e46d`; shell/client parciais, fachada e builds EAS pendentes |

Cada onda usou uma sessão/worktree própria. A integração local de W2 sobre W1
permite compilar contra as interfaces reais, sem integrar essas ondas na main.
Após o limite de uso dos coders Luna/xhigh, o dono autorizou o gerente a
corrigir diretamente a onda 2.

## Comandos e limites da evidência

| Verificação | Resultado |
| --- | --- |
| W1 `pnpm ci:local` | 18 gates aprovados no commit limpo `cf096e0`; 216 testes do workspace |
| W1 build e HTTP em modo de produção | API, HTML e asset passaram; nonce do HTML coincide com CSP |
| W2 instalação congelada | Passou com Node 24.22.3/pnpm 12.23.0 e política de supply chain preservada |
| W2 `pnpm turbo run lint typecheck test` | 14 tarefas aprovadas; suíte ampliada com 10 testes da guarda SQL; 1 teste condicionado à conexão real não roda nesse comando |
| W2 `pnpm --filter web build` | Passou |
| W2 `pnpm architecture:check` | Passou: 149 módulos, 374 dependências |
| W2 config gerada, invariantes e lint de migrations | Passaram; sem edição manual do `config.toml` fonte |
| W2 `supabase db reset` | Passou com sete migrations, executadas como `postgres`, no Docker da KVM |
| W2 `supabase test db` | Reprovou; o log registra os critérios de segurança/funcionalidade ainda não atendidos |
| W2 `pnpm db:types` e verificação de drift | Passaram contra o banco real; arquivo regenerado manteve o mesmo SHA-256 |
| W2 harness real pelo pooler TLS | Passou: claims, papéis, rollback, limpeza, microssegundos e auditoria atômica |
| W3 snapshot parcial: lint, typecheck e Jest/RNTL | Passaram; suíte ampliada com regressão para campos opcionais vazios |
| W3 Expo config, exports e prebuilds | Android/iOS passaram; não são builds EAS nem prova em dispositivo |
| W3 worktree completa | Teste e typecheck ainda falham porque `extensions/api.ts` está ausente; seu teste foi preservado fora do commit parcial |

Os recibos de `ci:local` ficam em `.artifacts/ci/` no checkout verificado. O
recibo do harness TLS, seu código e os hashes estão em
`.artifacts/w2-verification/`. O pgTAP usa um administrador descartável apenas
para fixtures e para assumir os papéis sob teste; não executa as migrations
como superusuário. Os helpers pgTAP ficam no schema temporário `test_support`.

## Onda 1 — critérios de aceite

Caminhos abaixo relativos a `apps/web/src/platform/` na branch W1.

| Critério | Prova | Estado |
| --- | --- | --- |
| Auth obrigatório por tipo | `http/define-route.type.test-d.ts` | Passou |
| Toda rota usa defineRoute; públicas iguais ao contrato | `http/route-contract.test.ts` | Passou |
| Registro vazio/fake e colisão de overrides | `extensions/composition.test.ts` | Passou |
| Redaction de logs e Sentry | `observability/redaction.test.ts` | Passou |
| Replay, chave em andamento e hash diferente | `http/define-route.test.ts`, `http/idempotency-store.test.ts` | Passou com portas falsas; lease antigo não altera o novo |
| Erros sem internals e Retry-After | `http/define-route.test.ts` | Passou |
| Balde global, limite de body e rotação de segredos | `http/body.test.ts`, `http/webhook-verifiers.test.ts` e pipeline | Passou |
| Host/prefixos, CSP e registros vazios | `edge/host-policy.test.ts`, `edge/csp.test.ts` | Passou nos caminhos recebidos pelo Proxy |
| Auditoria validada/fail-closed e subjectRef | `audit/audit.test.ts`; harness real em W2 | Passou |
| CAPTCHA widget único | `extensions/composition.test.ts` | Passou |
| CSP estrita D18 | `edge/csp.test.ts` | Passou |
| Headers de extensão e tabela de bypass de caminhos | `edge/csp.test.ts`, `edge/host-policy.test.ts`, S-TM-2 | **Parcial:** Next normaliza/redireciona algumas formas antes do Proxy |
| publicEnv restrito | `extensions/composition.test.ts` | Passou |
| Headers independentes e exclusão sem nonce | S-TM-2, `http/security-headers.test.ts`, teste da rota account-deletion | Passou nos casos observados; exceções pré-Proxy pendentes |
| IP compartilhado, IDs, políticas e erro do driver | Testes do pipeline/IP/rate-limit/request-id | Passou |
| Exceção de manutenção restrita | Testes de tipo, rota e pipeline | Passou |
| Suítes de contrato e isolamento de export | `testing/contracts/contracts.test.ts` | Passou |

## Onda 2 — critérios de aceite

| Critério | Prova | Estado |
| --- | --- | --- |
| Papéis, grants, ownership e isolamento por contexto | `w2_catalog_privileges.test.sql` | **Reprovou:** privilégios gerenciados não correspondem à spec |
| Claims com aspas/ponto e vírgula por bind | S-DB-1 e harness TLS do adaptador real | Passou |
| Expurgo apenas de registros vencidos | `w2_ops_purge_expired.test.sql` | Passou |
| Escritores de auditoria, negação de operator e set_setting auditado | `w2_audit.test.sql`, `w2_app_config_acceptance.test.sql` | Auditoria passou; set_setting bloqueado no acesso à contagem |
| Config gerada, fragmentos e drift | Testes de `supabase-config` e `supabase:config:check` | Passou |
| Grupos de auditoria e membros declarados | Catálogo contra fixtures JSON geradas | Comparação executada; associações administrativas sem SET/INHERIT são distinguidas das de execução |
| CAS de settings e alerta de operador | `w2_app_config_acceptance.test.sql`, `w2_ops_signals.test.sql` | Sinal de operador passou; CAS bloqueado antes da escrita |
| Leitor, RLS, allowlist, Storage/Realtime e GUC forjado | Catálogo e `w2_audit.test.sql` | Auditoria/GUC passaram; Storage e grants gerenciados reprovam |
| Lotes/contagens/heartbeat do expurgo | `w2_ops_purge_expired.test.sql` | Passou, inclusive segundo lote e zero linhas |
| Contas não confirmadas, todos os sinais e cadastro 301 | `w2_unconfirmed_*`, `w2_signup_hook.test.sql` | **Pendente/reprovou:** função/sinal ausentes; hook sem acesso a auth; e-mail 70/90 sem mapeamento do S-AU-4 |
| Ator/forma/cota de settings e lease de idempotência | `w2_app_config_shape.test.sql`, `w2_app_config_quota.test.sql`, `w2_idempotency.test.sql` | Forma/idempotência passaram; cota depende do acesso de auditoria pendente |
| Spikes registrados nos ADRs | ADR 0005 e ADR 0014 | S-DB-1 concluído localmente; S-TM-4 hospedado pendente |

Não foi acrescentado grant de auditoria nem helper de Auth para resolver uma
decisão que o dono ainda não tomou. Perfis/consentimentos (W4) e funções de
exclusão de conta (W9) não fazem parte desta entrega.

## Onda 3 — critérios de aceite

Caminhos abaixo relativos a `apps/mobile/` na branch W3.

| Critério | Prova | Estado |
| --- | --- | --- |
| Headers, rota pública sem token, refresh e tradução | `src/shared/api-client/api-client.test.ts` | Passou; inclui correlação e mensagem genérica localizada |
| Montagem com registro vazio e extensão fake | `src/features/shell/ui/app-providers.test.tsx` | Passou |
| CAPTCHA provider único | `src/extensions/registry.test.ts` | Passou |
| Fachada, sessão anterior e CAPTCHA dos métodos | `src/extensions/api.test.tsx` preservado | **Pendente:** sem implementação enquanto o domínio de retorno não for decidido |
| publicEnv e contexto sem sessão/tokens | Testes de registry e `types.type-test.ts` | Passou |
| URLs externas, cleartext e ATS | Testes de URL/app config e prebuilds | Passou localmente |
| Rotas sem mutação ao montar | Testes de arquitetura, providers e parâmetros | Passou |
| Paridade de traduções | `src/shared/i18n/check-locale-parity.test.ts` | Passou |
| Builds de desenvolvimento iOS/Android | EAS | **Não executados:** conta/projeto/assinatura pendentes |

## Decisões e ações externas

- W1: decidir a exigência para caminhos normalizados antes do Proxy; ADR 0003
  registra a prova de 308 sem headers e perda da forma original de `%2e`.
- W2: revisar base-app §3.8/ADR 0005 para o modelo suportado pelo Supabase atual;
  decidir os caminhos mínimos de auditoria e o transporte de alertas. A proposta
  no ADR não está aprovada. Não colocar segredos de envio numa baseline reprovada.
- W2: escolher um projeto Supabase autorizado para S-TM-4; o envio SMTP/Mailpit
  completo também permanece sem aceite enquanto o hook de cadastro falhar.
- W3: decidir os resultados inspecionáveis de `withPreviousSession<T>`; fornecer
  conta/projeto EAS e a configuração real de assinatura para os builds.
- W3: oito ocorrências vulneráveis em dependências transitivas foram corrigidas
  com pins e patch mínimo do EAS CLI (`71845f4`); o scan voltou a não apontar
  vulnerabilidades. `5513866` corrige o boot com campos opcionais vazios. O aviso
  do peer TypeScript do loader legado EAS é registrado no ADR 0002; a leitura
  local da configuração e a mesclagem corrigida foram exercitadas sem conta.
- Variáveis da API estão no `.env.example` raiz; variáveis mobile e localização
  de `.env.local` estão em `apps/mobile/README.md` e `.env.example` da branch W3.
  Segredos ficam no ambiente local/gerenciador, nunca no chat.

O próximo trabalho é fechar estas três ondas. No DAG, W1/W2/W3 podem executar
em paralelo; W4 pode se sobrepor a W3 depois de W1/W2; W8/W9 são paralelas, e
W10 pode se sobrepor a W8 depois de W9. Nenhuma onda 4+ foi implementada aqui.
