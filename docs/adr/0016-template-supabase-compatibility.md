# ADR 0016 — Baseline do template compatível com o Supabase

- **Status:** proposed — depende de decisão do dono
- **Data:** 2026-11-25
- **Revisa, se aprovado:** ADRs 0005/0008, base-app §3.8, specs de Auth/configuração/privacidade e a regra correspondente do AGENTS.md.

## Contexto

O template deve ser configurável por quem clona o repositório. A baseline
atual foi testada em Docker: o reset passa, mas o pgTAP encontra grants de
Auth e revogações de schemas gerenciados que `postgres` não pode aplicar.
Não se trata de falta de uma credencial do operador.

O Supabase documenta funções pequenas pertencentes a `postgres` como caminho
suportado para leituras de Auth por papéis customizados. Também documenta que
qualquer login do banco alcança as filas de `pg_net`; cabeçalhos com uma chave
Resend não ficam isolados por nossos REVOKEs.

- [Permissões do Auth](https://supabase.com/kb/troubleshooting/permission-errors-when-granting-custom-roles-access-to-the-auth-schema-9e32e7)
- [ACLs de pg_net](https://supabase.com/kb/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16)

## Proposta de decisão

Manter Data API desligada, papéis por contexto, `api_runtime` sem herança,
RLS forçado nas tabelas da aplicação, TLS, auditoria e validação. Substituir
somente as partes incompatíveis abaixo.

| Operação W2 | Proprietário | Chamador permitido |
| --- | --- | --- |
| `identity.before_user_created(jsonb)` | `postgres` | `supabase_auth_admin` |
| Contagem fixa de contas por e-mail não confirmadas | `postgres` | `ops` |
| Exclusão em lotes de 500 de contas elegíveis, sem filtro fornecido pelo chamador | `postgres` | `ops` |
| `ops.purge_unconfirmed_users()` e `ops.check_signals()` | `ops` | `postgres`/agendador |
| Contagem escalar de `app_config.updated` na última hora | `ops` | `app_config_admin` |

Todas as funções definidoras têm SQL fixo, relações qualificadas, search_path
vazio e EXECUTE revogado de PUBLIC e dos demais papéis. O registro de funções
privilegiadas fica fechado às funções do núcleo desta onda; extensões não
ganham autorização genérica para criar funções de Auth pertencentes a
`postgres`. Funções de privacidade e limpeza de senha continuam nas ondas
próprias, sem implementação antecipada.

O wrapper `ops` grava a contagem de purga com seu grant de auditoria já
existente. `app_config_admin` recebe somente a função escalar de contagem,
continuando sem SELECT direto dos eventos.

### Limite concorrente de cadastro

O COUNT seguido de aprovação do hook não garante o teto sob concorrência.
Propõe-se uma reserva atômica em janela móvel de uma hora, com no máximo 300
tentativas aprovadas. A tabela guarda somente identificador opaco e horário,
sem usuário, e-mail ou IP. Expurgo das reservas vencidas, contagem e inserção
ocorrem sob o mesmo lock transacional fixo. Falhas posteriores do Auth e
repetições podem consumir uma vaga por até uma hora; isso favorece o teto
estrito em vez de prometer contar somente cadastros concluídos.

### Alertas e superfícies gerenciadas

A baseline nova não instala nem envia credenciais por `pg_net`. `ops.alerts`
persiste os sinais; entrega externa de e-mail é um ponto operacional a
desenhar/documentar para o derivado, com credencial fora do banco. O sinal de
volume de e-mail depende do mapeamento S-AU-4 e não é inventado.

As provas de privilégio distinguem tabelas da aplicação de objetos gerenciados
pelo provedor. Mantêm ACLs exatas, RLS e negativas funcionais no app; para
Storage/Realtime verificam a superfície desabilitada e ausência de acesso a
dados, sem afirmar que um REVOKE sem efeito removeu ACLs do Supabase.

### Histórico de migrations

Para este template ainda não publicado, propõe-se consolidar a baseline
experimental em migrations novas e coerentes, preservando seu histórico no
Git. Isso exige autorização explícita como exceção à imutabilidade dos
arquivos já aplicados em laboratórios descartáveis. Não autoriza alterar
banco existente. Projetos que já aplicaram a baseline antiga exigem plano de
migração próprio; não se remove `pg_net`, filas ou webhooks de um projeto
existente automaticamente.

## Provas exigidas antes de aceitar

- Reset e suíte pgTAP completos, sem fixtures que concedam grants ausentes nas migrations.
- Hook sob o papel real de Auth e teste concorrente do teto; entrada inválida e cota esgotada falham fechadas.
- Matriz exata de proprietário/assinatura/EXECUTE/search_path e negação de chamada pelos papéis de runtime.
- Purga preserva contas recentes, confirmadas e contas anônimas; registra somente contagens, na mesma transação.
- CAS, cota de configuração, auditoria atômica e rollback passam sem SELECT direto de auditoria pelo escritor.
- Nenhum segredo em filas de banco; instalação em projeto existente falha com instrução explícita quando não há precondições seguras.
- Código, contratos, tipos e checks do template passam sem criar conta hospedada nem publicar app.

## Consequências e risco residual

O definidor `postgres` possui autoridade maior que o papel restrito originalmente
planejado. A redução do risco vem da superfície pequena, SQL fixo, validação,
allowlist e revisão/testes; não de um grant impossível. GUCs vinculam a operação
à transação, mas não autenticam o chamador. A autorização do usuário continua na
API, baseada em JWT verificado e na capacidade de purga quando ela for implementada.

A aprovação deve incluir a atualização estritamente necessária do AGENTS.md e
das specs/ADRs, sem sobrescrever o restante do guia. Até lá, esta é somente uma
proposta; nenhuma dessas permissões, remoções ou consolidações foi executada.
