# Fluxos de autenticação (Maestro)

Os fluxos usam credenciais fornecidas pelo ambiente seguro do runner. Não coloque e-mails,
senhas, códigos ou chaves nos YAMLs, argumentos do processo, screenshots, relatórios ou logs.
O runner executa primeiro o gesto que solicita o código, consulta o Mailpit local depois desse
gesto e só então passa o código à segunda fase do fluxo. A saída do Maestro é suprimida e os
artefatos temporários são apagados ao final.

## Pré-requisitos

- Node.js 24, Maestro CLI e emulador/aparelho Android ou iOS com o app de desenvolvimento
  instalado.
- App, API local e Auth acessíveis por HTTPS com certificado confiável no aparelho.
- Mailpit local acessível ao runner. Se a stack estiver em uma KVM, o operador precisa fornecer
  um encaminhamento HTTPS restrito ao serviço local.
- Fixtures separadas: conta para login por código, conta confirmada para recuperação e troca de
  senha, e um endereço descartável ainda não cadastrado para signup.
- Login por código e signup usam contas sem aceite das versões legais atuais; recuperação e
  troca de senha usam uma conta que já aceitou os documentos atuais.
- `MAESTRO_APP_ID` é o bundle ID/package público derivado de
  `packages/config/src/product.config.ts`.

## Entradas externas

Configure somente as entradas do cenário que será executado. Não use `echo`, `set -x` ou
argumentos `-e` com valores de conta. O runner recebe variáveis `MAESTRO_*` do ambiente:

| Cenário | Entradas |
|---|---|
| `login-email-code` | `MAESTRO_AUTH_EMAIL` |
| `signup-email-password` | `MAESTRO_SIGNUP_EMAIL`, `MAESTRO_SIGNUP_PASSWORD` |
| `password-recovery` | `MAESTRO_RECOVERY_EMAIL`, `MAESTRO_RECOVERY_PASSWORD` |
| `change-password` | `MAESTRO_LOGIN_EMAIL`, `MAESTRO_LOGIN_PASSWORD`, `MAESTRO_NEW_PASSWORD` |

Todos os cenários exigem `MAESTRO_APP_ID` e `MAESTRO_MAILPIT_BASE_URL`. Se Mailpit exigir
Basic Auth, injete `MAESTRO_MAILPIT_USERNAME` e `MAESTRO_MAILPIT_PASSWORD` por secret manager.
O endereço e o código nunca aparecem em route params; os flows não registram campos. O runner
não relata a URL, destinatário, corpo de e-mail nem código.

## Execução

Execute a partir da raiz do checkout W6:

```sh
node apps/mobile/e2e/auth/run-auth-e2e.mjs login-email-code
```

Use `signup-email-password`, `password-recovery` ou `change-password` para os outros fluxos.
O código é selecionado apenas de uma mensagem Mailpit recebida depois do gesto de envio daquele
fluxo; um código pré-injetado não satisfaz o teste. Os resultados persistentes contêm somente
horário, nome do cenário e códigos de saída. Capturas e relatórios temporários são removidos ao
final.

Maestro ainda não foi executado nesta sessão: requer dispositivo/ADB funcional, API/Auth/Mailpit
local acessível por TLS confiável e a janela de uso exclusivo da Auth concedida pelo gerente.
