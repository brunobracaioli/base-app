# ADR 0017 — Operação local de configuração com aprovação assinada

- **Status:** accepted
- **Data:** 2026-11-26
- **Aprovação:** o dono autorizou implementar todas as pendências e prosseguir pelas ondas
  restantes numa execução contínua. Isso substitui a limitação de uma onda por sessão,
  preservando dependências, commits/branches por onda e os gates antes de cada aceite.

## Contexto

O ADR 0015 removeu Actions, mas a operação de configuração ainda dependia de seu
Environment. O writer não podia ler o token CAS nem o histórico do rollback, e o setter
não recebia force. O contrato decimal também excedia o `int[]` da comparação SQL.
As quatro propostas de `wave-5-execution.md` foram aprovadas pelo dono.

## Decisão

- `app_config.read_setting(p_key text)` retorna zero ou uma linha com `value jsonb` e
  `updated_at timestamptz`; pertence a `app_config_admin`.
- `app_config.read_rollback_setting(p_key text)` retorna zero ou uma linha com
  `event_id uuid`, `before_value jsonb`, `after_value jsonb`, `occurred_at timestamptz`,
  do último evento de sucesso da chave. Pertence a `app_config_history_reader`, papel
  NOLOGIN com grants de colunas e RLS restritos a esses eventos. Não é membro de
  `audit_reader` e não amplia `ops`. Empate ordena por occurred_at e id.
- Os leitores são SECURITY DEFINER, SQL fixo, search_path vazio, allowlist das três
  chaves e EXECUTE somente para `app_config_writer` e seus proprietários. Nenhum
  SELECT direto é concedido ao writer, à API ou aos usuários.
- `set_setting` ganha overload com os seis argumentos existentes e `p_force boolean`.
  A aridade antiga chama a nova com false. A nova preserva CAS, locks, quota, ator,
  transação atômica e registra `metadata.force`. A ação `app_config.updated` fica
  reservada a `app_config_admin` em policy restritiva de INSERT, bloqueando falsificações
  por todos os escritores genéricos. Por ser um template ainda não publicado, a
  migration recusa histórico preexistente dessa ação sob lock; esse legado não
  tem origem comprovável e exige reconciliação explícita, sem apagar auditoria.
  Migrations antigas permanecem imutáveis.
- A validação SQL de versões usa comparação decimal sem o limite de int32; o helper
  antigo pode ser preservado para compatibilidade. O limite de tamanho da linha continua.
- `app-config:set` e `app-config:rollback` produzem plano com diff e CAS por leitura
  restrita. Dry-run não escreve. Preparação, assinatura e execução são etapas distintas.
  O plano estrito/versionado inclui identificador, destino sem senha, commit/tree,
  chave, before/after, expectedUpdatedAt exato, force, origem do rollback e validade.
- Duas identidades confiáveis distintas assinam o mesmo payload canônico com Ed25519.
  A chave pública identifica o signatário num registro externo confiável; identidades
  ou chaves duplicadas são recusadas. A expiração máxima do plano é uma hora.
  Assinaturas cobrem prefixo de domínio e bytes canônicos, sem segredos.
- O executor verifica ambas as assinaturas, validade, destino e checkout limpo antes
  da mutação; relê o snapshot e exige o CAS assinado, sem retry de escrita.
  Usa TLS verificado e login dedicado que só assume `app_config_writer`.
  Run ID é o identificador do plano; o digest fica no recibo e correlation_id,
  vinculando o evento à aprovação. Chaves e recibos ficam fora do checkout.
- Segredos: `APP_CONFIG_ADMIN_DATABASE_URL`, `APP_CONFIG_ADMIN_DATABASE_CA_CERT`;
  política/chaves por caminhos externos `APP_CONFIG_TRUST_FILE` e
  `APP_CONFIG_SIGNING_KEY_FILE`. Valores vazios no `.env.example` e nunca no app.
- O app online/foreground consulta a configuração a cada 60 s em qualquer gate.
  Idade de resposta pode chegar a 150 s; detecção periódica até 210 s mais rede.
  Gate do servidor até 60 s com banco disponível. Offline/background não têm
  garantia temporal; manutenção armazenada não bloqueia offline, atualização sim.

## Consequências

A aprovação é um controle verificável do executor. Quem já possui a credencial do
banco pode chamar SQL diretamente; host/registro de confiança comprometidos também
contornam o controle. Esse residual é explícito, como no acesso administrativo anterior;
não se cria broker novo. Credencial de produção fica na máquina autorizada do operador,
nunca na KVM de testes. Testes usam chaves efêmeras geradas em memória e banco descartável.

CAS impede replay do plano depois de uma gravação bem-sucedida. Em resultado incerto,
o operador reconcilia pelo run ID/correlation_id; o comando não repete a mutação sozinho.
A prova local verifica assinatura distinta, adulteração, expiração, isolamento de grants,
force auditado, rollback, conflitos e negativos. Aprovações reais e contas do derivado
continuam uma configuração humana posterior; não são simuladas.
