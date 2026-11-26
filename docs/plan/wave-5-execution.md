# Execução da onda 5 — Configuração remota e gates

## Base e escopo

Branch `feat/w5-config-gates`, worktree `/tmp/app-base-w5`, criada da `main`
atualizada e integrada localmente com a onda 4 (`c690f28`). Sem push, Actions,
projeto hospedado ou release. A onda entrega somente configuração remota,
gates de versão/manutenção e operação por script.

## Plano e provas

1. `packages/contracts/src/app-config.ts`, registro de endpoints e OpenAPI:
   schemas estritos, versão numérica, resposta pública, 60/min por IP e
   falha aberta do rate limit. Testes de contrato e drift antes dos handlers.
2. `apps/web/src/modules/app-config/**`, composição e pipeline HTTP:
   repositório com `systemDb('app-config')`, cache 30 s, último valor válido por
   chave, fallback sem bloqueio, URLs do produto e métrica sem payload.
   Testes com relógio injetado provam expiração, concorrência, fallback,
   426/503, métodos, precedência e isenções. Integração confirma GET /v1/me 503.
3. `apps/mobile/src/features/app-config/**`, providers, telas e traduções:
   `evaluateGate`, consulta limitada a 3 s, AsyncStorage validado, versão nativa,
   integração no boot e atualização por eventos/consulta periódica.
   Jest/RNTL prova boot, offline, resposta inválida, atualização/manutenção,
   mensagem desconhecida, botão da loja e recuperação sem reiniciar o app.
4. Script de operação, migration aditiva e pgTAP: validação cruzada, diff,
   dry-run, guarda de salto, force, rollback e CAS; nenhuma escrita direta.
   Testes negativos de permissões, auditoria atômica, conflito e duas pessoas.
   A implementação dos pontos abaixo aguarda a decisão específica do dono.
5. Verificação: comandos prescritos da onda, `ci:local`, build web, exports
   mobile, reset/pgTAP real em stack descartável da KVM e drift de tipos.
   Matriz de critérios e limites de prova local documentada antes de marcar ✅.

## Lacunas submetidas ao dono

- **Leitura/rollback e force:** app-config §§3.3–4 exige leitura por uma
  credencial com EXECUTE apenas, sem leitor declarado; a função de seis
  argumentos também não recebe force. Proposta: leitores restritos por chave
  para valor/updated_at e último before; versão compatível de set_setting
  que audita force. Sem SELECT de tabela para writer.
- **Duas pessoas fora de Actions:** ADR 0015 removeu o executor, preservando
  aprovação sensível. Proposta: plano assinado por solicitante e aprovador
  distintos, chaves públicas confiáveis externas, binding a destino, commit,
  diff e CAS, prazo de validade. Sem autodeclaração de identidade por flag.
- **Tempo do mobile:** 150 s é idade de resposta (CDN 60+60, origem 30), não
  detecção em tela com consulta a cada 60 s. Proposta: explicitar até 210 s
  mais rede em foreground; servidor até 60 s com banco disponível; nenhuma
  garantia offline/background.

## Consistência já decidida nas specs

AC-02 e §3.2 prevalecem sobre a menção antiga a manutenção somente em escrita.
O CAS de §3.3/4 e NX-24 prevalece sobre a linha antiga de última escrita vence.
AC-07 permite offline, exceto quando o cache exige atualização; manutenção
armazenada não impede o uso offline. As URLs e exemplos vêm do produto existente.
As assinaturas reais, HIT de CDN e testes nativos permanecem no checklist do
app derivado; testes locais não serão descritos como execução hospedada.

## Revisão de segurança da operação — proposta adicional

A revisão encontrou `semver_key(text) -> int[]` na baseline: componentes
aceitos pelo contrato podem exceder o inteiro de 32 bits. Proposta pendente:
alinhar a comparação SQL ao formato decimal do contrato, sem estreitar a API.

O rollback também não deve confiar em eventos `app_config.updated` inseridos
por outros membros de `audit_writer`. Proposta pendente: reservar essa ação
para o mutator autorizado e usar um papel sem login de leitura restrita a
esses eventos para a função de rollback. `ops` não tem acesso atual a
`metadata`; não se ampliará esse papel de manutenção nem o acesso do writer.

Assinaturas distintas protegem o executor e o plano exato. Não são uma
barreira contra quem já detém a credencial do banco e chama SQL diretamente,
nem contra um host executor comprometido. A credencial deve permanecer na
máquina autorizada do operador; não será copiada para a KVM. O residual deve
constar do ADR e do runbook. Não será criado um broker ou serviço novo nesta onda.
