# Alterar a configuração remota do app

> **Status: proposta pendente.** O CLI de leitura e escrita ainda não está habilitado.
> A implementação atual cobre apenas validação e planejamento puro; ela não conecta ao
> banco e não grava configuração.

Este guia descreve a interface proposta para a operação local depois que o dono aprovar
as funções de leitura com escopo por chave, a auditoria compatível de `--force` e a
aprovação local por duas pessoas vinculada à operação exata. Até essa decisão, não use
os exemplos como comandos executáveis.

## Sintaxe proposta

```bash
pnpm app-config:set versions --json '{"ios":{"minSupported":"1.2.0","latest":"1.4.0"},"android":{"minSupported":"1.2.0","latest":"1.4.0"}}' --dry-run
pnpm app-config:set maintenance --file maintenance.json --dry-run
pnpm app-config:rollback versions --dry-run
```

O plano mostra a diferença validada e o `updated_at` exato que seria usado como token
CAS. O CLI deverá manter os microssegundos devolvidos pelo PostgreSQL. Um conflito
`AC409` será apresentado como `409 app_config.conflict`; o CLI não repetirá uma escrita
automaticamente.

## Guardas previstas

- O comando valida a chave e o valor com `appConfigValueSchemas` exportado pelo contexto
  `app-config`.
- `minSupported` precisa ser menor ou igual ao `latest` proposto. A guarda também impede
  que `minSupported` salte além do `latest` atualmente armazenado ou da versão `published`
  para a loja, salvo `--force` aprovado e registrado na mesma auditoria da escrita.
- Um `maintenance.until` informado precisa estar no futuro segundo o relógio injetado do
  processo.
- A reversão usa o último evento de sucesso da chave, valida que o `after` desse evento
  ainda corresponde ao valor atual e reaplica `before` com o `updated_at` atual. Uma
  gravação concorrente invalida o plano.
- A entrada JSON é limitada a 2 KiB e valores desconhecidos são recusados pelos schemas
  estritos. Erros de banco não exibem mensagens do driver, SQL, URL de conexão ou segredo.
- Com o banco disponível, o gate do servidor deverá refletir uma mudança em até 60 s. O
  app poderá levar até 210 s mais o tempo de uma consulta de rede em foreground. Não há
  limite durante offline ou em background; o cache não substitui o gate do servidor.

## Aprovação e credenciais

Quando habilitada, a execução deverá usar conexão TLS com um login dedicado que só assume
`app_config_writer`. O script de produto nunca usará a senha de `postgres`. O acesso de
leitura deverá ficar restrito às funções por chave aprovadas; o writer não receberá
`SELECT` direto nas tabelas `app_config.settings` ou `audit.events`.

O aprovador e o solicitante deverão ser pessoas distintas. A aprovação precisa estar
criptograficamente vinculada à chave, ao destino, ao commit, ao diff, ao token CAS e ao
prazo de validade. As credenciais reais de produção permanecem na máquina autorizada do
operador. Uma KVM pode receber somente credenciais efêmeras de teste, nunca o segredo de
produção ou credenciais GitHub/nuvem.

Até a habilitação do adapter e da aprovação, use apenas os testes direcionados:

```bash
pnpm app-config:operator:test
```
