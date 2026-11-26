# Alterar a configuração remota do app

O CLI prepara planos locais para alterar `versions`, `maintenance` e `legal`. Toda escrita
usa a API `app_config.set_setting` e exige duas assinaturas Ed25519 de identidades distintas
presentes no registro de confiança do operador. O CLI não acessa diretamente as tabelas de
configuração ou auditoria.

Este guia descreve operações locais contra o banco indicado nas variáveis do operador. Ele
não configura contas de produção, publica configuração, faz deploy ou testa a propagação pela
CDN. O comportamento em serviço hospedado continua sujeito aos gates e provas próprios do
derivado.

## Pré-requisitos locais

Prepare os pacotes compartilhados antes de carregar credenciais ou chaves no ambiente:

```bash
pnpm install --frozen-lockfile
pnpm --filter @base-app/config build
pnpm --filter @base-app/contracts build
```

O executor usa esses artefatos já preparados; as etapas de assinatura/execução não
instalam dependências nem executam builds. Repita a preparação quando atualizar o código.

Configure os arquivos e variáveis conforme a etapa:

- `APP_CONFIG_ADMIN_DATABASE_URL` e `APP_CONFIG_ADMIN_DATABASE_CA_CERT` são usados por
  `app-config:set`, `app-config:rollback` e `app-config:execute`. A URL identifica um login PostgreSQL dedicado, membro apenas do
  papel necessário para assumir `app_config_writer`. O login `postgres` é recusado.
- `APP_CONFIG_ADMIN_DATABASE_CA_CERT` contém o certificado CA PEM para TLS verificado. Parâmetros de
  query na URL são recusados; a conexão não aceita `sslmode`, `sslcert`, `sslkey` ou overrides
  equivalentes. Host, porta, banco e usuário são passados explicitamente ao pool, portanto
  variáveis ambiente como `PGPORT` não substituem o destino aprovado.
- `APP_CONFIG_TRUST_FILE`: caminho absoluto para o registro JSON de confiança, fora do
  checkout. O arquivo deve pertencer ao operador, ter modo `0600` e estar numa pasta `0700`.
- `APP_CONFIG_SIGNING_KEY_FILE`: caminho absoluto para a chave Ed25519 privada do signatário,
  fora do checkout, com modo `0600` e pasta `0700`. Necessária somente para `app-config:sign`.

`set`, `rollback` e `--dry-run` nunca carregam a chave privada. `sign` precisa apenas do trust
file e da chave privada; o destino aparece no plano revisado e só é comparado à conexão real
na execução. `execute` não precisa de uma chave privada.

O registro contém no mínimo duas chaves públicas Ed25519 com impressões SHA-256 dos bytes DER
SubjectPublicKeyInfo. O formato é estrito:

```json
{
  "version": 1,
  "identities": {
    "identidade-a": {
      "publicKeyPem": "chave pública PEM cadastrada pelo responsável",
      "fingerprintSha256": "impressão SHA-256 cadastrada e verificada"
    },
    "identidade-b": {
      "publicKeyPem": "outra chave pública PEM cadastrada pelo responsável",
      "fingerprintSha256": "outra impressão SHA-256 cadastrada e verificada"
    }
  }
}
```

Os textos acima descrevem campos e não são valores copiáveis. Cadastre chaves públicas e
impressões por um processo confiável da organização. O CLI não gera, guarda ou simula chaves
de produção. Trust, chave privada e plano precisam ficar em arquivos absolutos externos ao
checkout; links simbólicos, arquivos de outro usuário, permissões mais abertas que `0600` e
planos dentro do repositório são recusados. O diretório padrão dos planos é
`$XDG_STATE_HOME/base-app/app-config/plans` ou
`~/.local/state/base-app/app-config/plans`, criado com modo `0700`.

Mantenha o relógio da máquina sincronizado. Um plano preparado com horário futuro é recusado.
A validade padrão é de 15 minutos e nunca pode exceder uma hora.

## Preparar um plano

`--dry-run` valida o valor e consulta o snapshot atual, mostrando o diff sem criar plano,
assinar ou escrever no banco:

```bash
pnpm app-config:set maintenance --json '{"active":false}' --dry-run
pnpm app-config:rollback legal --dry-run
```

Para preparar uma alteração, retire `--dry-run`. O comando valida a chave com
`appConfigValueSchemas`, lê `value` e `updated_at` pela função restrita, mostra o diff e grava
um plano sem assinaturas fora do checkout, com modo `0600`:

```bash
pnpm app-config:set <chave> --file /caminho/externo/valor.json
pnpm app-config:rollback <chave>
```

Substitua `<chave>` por `versions`, `maintenance` ou `legal`; o arquivo deve conter um objeto
JSON de até 2 KiB e não pode ter membros duplicados. O comando imprime `plan_file`,
`plan_sha256` e o resumo assinado. O plano vincula o destino (sem senha), commit e tree limpos,
diff, snapshot anterior, `updated_at` com precisão integral, `force`, evento de origem do
rollback, identificador e validade. Se o checkout mudar, será preciso preparar um plano novo.

`--force` só remove as guardas de salto de versão indicadas no plano. A decisão force fica
assinada e é enviada ao setter de sete argumentos para auditoria em `metadata.force`.

## Revisar e assinar

Cada signatário revisa o destino, o diff, o token CAS, o expiry e, quando aplicável, o evento
de rollback e a decisão force. O comando sempre imprime esse resumo. Para assinar, o operador
também precisa informar exatamente o digest do plano revisado:

```bash
pnpm app-config:sign --plan /caminho/externo/plano.json --approve-sha256 <plan_sha256>
```

O comando rejeita digest ausente ou diferente. Cada pessoa usa a própria chave privada e o
mesmo registro de confiança; a segunda assinatura precisa vir de outra identidade e chave.
Uma identidade não pode assinar duas vezes. O comando atualiza o plano atomicamente e preserva
as assinaturas anteriores.

## Executar

Depois de conferir que o plano tem duas assinaturas válidas e distintas:

```bash
pnpm app-config:execute --plan /caminho/externo/plano.json
```

Antes de conectar, o executor verifica assinatura, validade, destino, checkout limpo, commit,
tree e diff. Então relê o snapshot e, em rollback, o evento mais recente da chave. Se o CAS ou
a origem mudou, não chama o mutator. A chamada ao setter ocorre uma única vez; `AC409` aparece
como `app_config.conflict` e não há retry automático. Em resultado incerto, reconcilie o plano
pelo `plan_id` e `correlation_id` na auditoria antes de preparar outra operação.

## Erros e limites

- Erros e logs não mostram senha, URL completa, SQL nem mensagem do driver.
- Nenhuma leitura faz `SELECT` direto em `app_config.settings` ou `audit.events`; nenhuma
  escrita faz DML direto nessas tabelas.
- A conexão usa TLS com verificação CA e timeouts. O plano não contém senha.
- O controle de duas pessoas protege este executor. Quem já possui a credencial do banco ainda
  pode chamar SQL diretamente; comprometimento do host ou do trust file também contorna o
  controle. Esse limite é registrado no [ADR 0017](../adr/0017-local-app-config-operations.md).
- A aceitação local do comando não demonstra aplicação em produção, propagação da CDN ou teste
  em app derivado.

## Verificação local do operador

```bash
pnpm app-config:operator:test
pnpm app-config:operator:typecheck
pnpm --filter web lint
pnpm format:check
```
