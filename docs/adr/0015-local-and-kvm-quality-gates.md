# ADR 0015 — Gates locais e em KVM, sem GitHub Actions

- **Status:** accepted
- **Data:** 2026-11-24
- **Substitui:** ADR 0012 quanto ao executor de CI e às aprovações específicas de Actions.

## Contexto

O dono determinou que o projeto use execução local ou as KVMs existentes da
Hostinger, como no fluxo já utilizado em seus projetos. A tentativa de Actions
gerou `BuildFailed`/`startup_failure` sem jobs, inclusive em um workflow isolado
com apenas `echo`; não houve falha executada de teste ou evidência de causa exata.
As validações locais da fundação passaram.

## Decisão

- O contrato executável é `pnpm ci:local`, descrito em
  [local-quality-gates.md](../specs/local-quality-gates.md). Os gates permanecem;
  muda o executor. GitHub Actions fica desativado e não há workflow executável
  de Actions no template.
- O gate gera recibo e logs por commit/tree. Só uma execução integral, em
  checkout limpo e sem alteração durante a bateria, pode atestar um commit.
  O status publicado no GitHub identifica a origem: `CI / local`.
- A máquina local é suficiente para a onda 0. Quando necessária, uma KVM já
  existente recebe o código por `git bundle`, trabalha em checkout isolado e
  devolve as mesmas evidências; uma execução por VM. Esse padrão reutiliza o
  fluxo operacional da skill `vm-ci-gate`, sem provisionar/reinstalar máquinas.
- Nenhum `.env`, segredo de GitHub/nuvem ou credencial de produção vai para a
  VM ou para os recibos. A sessão só consulta credenciais externas se uma
  conexão autorizada for necessária. Subprocessos recebem ambiente limitado.
- O baseline GitHub passa a exigir o status local nos rulesets. Environments
  de Actions deixam de ser requisito padrão; o doctor mantém suporte para
  verificar configurações que os declarem explicitamente.
- Migrations remotas, deploy, envio às lojas e assinatura/publicação OTA
  continuam exigindo aprovação humana explícita e gates próprios. Os fluxos
  operacionais das ondas futuras serão implementados fora de Actions. Não se
  considera uma aprovação de CI como aprovação de release.

## Consequências

- O PR pode ser validado sem depender de minutos, registro ou runners de Actions.
  O status local é uma declaração do operador baseada no recibo, não uma
  execução hospedada pelo GitHub.
- A execução local não é uma sandbox de filesystem: código não confiável exige
  ambiente isolado antes de rodar. O gate não carrega `.env` e não herda tokens
  da sessão; a KVM dedicada amplia o isolamento quando necessária.
- O resultado local de um commit não valida automaticamente outro. O SHA e a
  tree permitem conferir exatamente o conteúdo testado, inclusive em squash.
- As referências anteriores a `ci.yml`, `db-migrate.yml`, `app-config-set.yml`,
  `release-ota.yml`, `GITHUB_TOKEN` e GitHub Environments nas specs são históricas
  quanto ao executor; os requisitos funcionais, menor privilégio, separação de
  segredos e aprovação de operações sensíveis continuam válidos.
- Os gates de banco entram na onda 2. A onda 0 não cria migrations, banco ou
  testes vazios para simular essa validação.
