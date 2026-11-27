# W6 — Resultados dos spikes de Auth

**Data:** 2026-11-27 · **Status:** spikes, notificações localizadas e pré-sequestro verificados na
stack local; migration imutável aplicada somente na stack descartável.

## Ambiente e limites

Spikes executados na stack Supabase descartável `app-base-overnight-verify`, em `ci-r3`:
Supabase CLI 3.4.0, GoTrue v2.198.0, PostgreSQL 17.12.0.002 e Mailpit. API, banco e Mailpit
ficaram limitados a loopback. Nenhum projeto hospedado foi consultado ou alterado. As saídas
registram somente códigos de erro, booleanos e contagens; não exibem e-mail, OTP, senha, token ou
corpo. Cada usuário e mensagem de fixture das execuções concluídas foi apagado.

As saídas finais com apenas booleanos, códigos de erro e contagens estão em
`.artifacts/recovery/w6/receipts/auth-acceptance-final.json`.

O harness está em [`supabase/tools/w6-auth-spikes.mjs`](../../supabase/tools/w6-auth-spikes.mjs).
Comandos usados para os resultados S-AU-3a, S-AU-3b e S-AU-4:

```bash
node supabase/tools/w6-auth-spikes.mjs sau3a
node supabase/tools/w6-auth-spikes.mjs sau3b
node supabase/tools/w6-auth-spikes.mjs sau4
```

## Resultados observados

| Spike | Resultado local | Decisão |
|-------|-----------------|---------|
| S-AU-1 — templates | A prova de ramificação com marcadores cobriu cinco tipos e três idiomas. Uma regressão na cópia final deixou o ramo EN vazio e foi detectada como `otp_missing`; a edição de idioma havia removido seu corpo. O ramo foi restaurado. O rerun EN confirmou assunto, corpo, OTP, prazo e aviso de não compartilhamento; S-AU-3a confirmou essas mesmas partes nos seis códigos de troca de e-mail PT/EN/ES. | Template localizado com fallback pt-BR; reautenticação usa `GET /auth/v1/reauthenticate` (GoTrue 2.198 registra GET embora seu OpenAPI liste POST). O harness falha se faltar cópia, token, expiração ou aviso. |
| S-AU-2 — pré-sequestro | `verifyOtp({ type: 'signup' })` aceitou cadastro direto. Sign-in do atacante foi recusado antes da confirmação (`email_not_confirmed`) e depois da confirmação da vítima (`invalid_credentials`). Cadastro OTP-only aceitou `verifyOtp({ type: 'email' })`, definiu senha depois da confirmação e entrou com ela. | Plano B e trigger aplicados. Migration pelo CLI local, 6 assertions pgTAP do W6 aprovados, e teste pré-sequestro end-to-end passou. A migration não foi alterada depois da aplicação. |
| S-AU-3a — troca de e-mail | Em PT/EN/ES, as duas confirmações `type: 'email_change'` foram aceitas. A primeira manteve o e-mail ativo; a segunda concluiu a troca. Os dois OTPs por idioma passaram corpo/assunto/token/prazo/aviso; a notificação de troca chegou ao endereço anterior e passou os checks de locale. 3 usuários e 9 mensagens foram limpos. | Exigir os dois códigos; só então o e-mail ativo muda. |
| S-AU-3b — troca de senha | Sessão recém-autenticada aceitou `updateUser({ password })` sem nonce; com nonce também passou. Avisos de senha chegaram em PT/EN/ES e passaram checks de corpo/assunto. 3 usuários e 5 mensagens foram limpos. | O app sempre solicita `reauthenticate()` e envia o nonce; chamada direta ao Auth ainda pode contornar o fluxo durante sessão recente (R-ID-4). |
| S-AU-4 — abuso de OTP/e-mail | Dez códigos errados responderam `otp_expired`; o código correto ainda foi aceito. Agrupamento IPv6 `/64` não foi provado. Reenvio ao mesmo endereço dentro de `max_frequency` foi bloqueado com HTTP 429 `over_email_send_rate_limit`. Ações observadas: `user_confirmation_requested`, `user_recovery_requested`, `user_reauthenticate_requested`, `user_modified`. Cinco usuários e seis mensagens foram limpos. | Plano B selecionado: OTP de 10 dígitos, expiração de 300 s e 10 verificações por 5 min por IP. `max_frequency` fica em 60 s. As ações de auditoria identificam fluxos, não formam contador global de `email_sent`; monitoramento do teto fica no projeto Supabase/runbook. CAPTCHA é recomendado para app público. |

## Notificações de segurança

GoTrue v2.198.0 contém configurações distintas para `password_changed` e `email_changed`; ambas
ficam desligadas por padrão. A configuração W6 agora habilita as duas com assuntos e corpos nos
três idiomas. A CLI 3.4.0 aceitou os blocos e validou os caminhos em uma pasta temporária
isolada, sem iniciar ou reiniciar a stack. O comando registrou duas referências `env()` não
resolvidas; `config validate --resolve-env` não foi executado, então a validação não cobre os
valores de ambiente SMTP. A ausência inicial de mensagens era estado desabilitado do fixture,
não falta de suporte.

Após a configuração ser aplicada e a Auth reiniciada pelo manager, os avisos de senha e de e-mail
chegaram nas três línguas. O aviso de troca de e-mail foi enviado ao endereço antigo, conforme o
GoTrue v2.198.0.

## Configuração selecionada

`supabase/config.base.toml` define `otp_length = 10`, `otp_expiry = 300`,
`token_verifications = 10`, `max_frequency = "60s"`, além das notificações de alteração de senha
e e-mail habilitadas. O guard de configuração exige o perfil e impede que um fragmento o afrouxe.
`supabase/config.toml` foi regenerado; não foi editado manualmente.

## Migration e pré-sequestro

O parent manager aplicou `20261127015300_w6_email_auth_safety.sql` pelo CLI local após revisar o
SHA-256 `c6313f578d8c392c8b9684b979df54e005edc289a82cddfef5eac4127069a343`. O teste W6 e o
catálogo confirmaram owner, `SECURITY DEFINER`, `search_path`, ACL e comportamento de primeira
confirmação. Após `finish()` ser adicionado ao arquivo pgTAP, a suíte local passou: 14 arquivos,
294 assertions, incluindo as 6 assertions W6. O fluxo direto do atacante falhou antes e depois da
confirmação da vítima; o cadastro OTP-only definiu senha depois e conseguiu entrar. Nada foi
aplicado ou alterado em serviço hospedado.

Referências técnicas: [templates locais do Supabase](https://supabase.com/docs/guides/local-development/customizing-email-templates),
[configuração GoTrue v2.198.0](https://github.com/supabase/auth/blob/v2.198.0/internal/conf/configuration.go)
e [destinatário do aviso de e-mail alterado no GoTrue v2.198.0](https://github.com/supabase/auth/blob/v2.198.0/internal/mailer/templatemailer/templatemailer.go),
que envia esse aviso ao endereço anterior.
