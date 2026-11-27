# Verificação da onda 6 — Login por e-mail

## Estado

Em verificação final em 2026-11-27, na branch `feat/w6-email-auth`, worktree
persistente `.worktrees/w6`. W5 está integrada na `main` em `6387bc3`.
A implementação foi consolidada em `cb6a2da`. Depois, o dono priorizou o starter
para alunos e solicitou somente sua documentação; as ondas futuras não são uma
obrigação automática. A QA nativa permanece pendente. Não houve deploy nem alteração
de serviço hospedado.

## Evidências observadas

| Verificação | Resultado |
| --- | --- |
| Mobile após as correções | 27 suítes, 189 testes; lint e typecheck aprovados |
| Demais pacotes | 14 tarefas de lint/typecheck/test aprovadas; 435 testes e um condicionado não executado, separado |
| Arquitetura e formato | Sem violações em 360 módulos/1.021 dependências; Prettier aprovado |
| Sessão e consentimento ao reconectar | Regressões de token expirado/offline, sessão revogada, eventos atrasados, perfil em cache e retry no bootstrap gerenciado aprovadas; repetição provocada pela própria renovação permanece limitada |
| Auth/Mailpit | Pré-sequestro, OTP-first, troca de e-mail em duas etapas e notificações localizadas verificados na stack descartável; detalhes em `wave-6-auth-spikes.md` |
| Migration W6 | Aplicada no laboratório; SHA preservado; função restrita, ACL, owner e primeira confirmação cobertos |
| pgTAP fresco | 294 asserções em 14 arquivos aprovadas após corrigir isolamento dos testes de manutenção |
| Preservação do histórico | Dois eventos existentes antes e depois da suíte; hashes dos eventos preexistentes intactos |
| Tipos Kysely | Oito tabelas introspectadas com TLS validado; arquivo gerado sem drift |
| Build web | Next.js 16.4.6, build de produção aprovado |
| Segurança e CI local | 18/18 gates aprovados em `cb6a2da`, checkout limpo e recibo atestável; inclui Semgrep, Gitleaks, OSV e Zizmor |
| Android | APK debug de fixture x86_64 compilado e instalado em AVD API36; a tentativa Maestro terminou com timeout124 no DevLauncher, sem abrir Welcome nem exercitar Auth |
| Revisão final | Achados anteriores corrigidos e rechecados em `cb6a2da`; QA nativa não aprovada |

Os recibos sanitizados ficam em `.artifacts/recovery/w6/` no checkout principal.
`receipts/auth-acceptance-final.json` registra as provas anteriores de Auth;
`receipts/pgtap-isolation-20261127.json` registra a suíte fresca e a preservação
do histórico. Inputs privados do laboratório não fazem parte dos artefatos
versionados nem devem ser copiados para o app.

## Regressões encontradas na retomada

A suíte pgTAP que passara após reset falhou em oito asserções quando o banco
já continha heartbeats do cron. Três testes agora isolam suas fixtures dentro
de transações com rollback, seguindo a ordem dos locks dos jobs. As funções,
permissões e migrations de produção não foram alteradas por essa correção.
A suíte passou sem reset e a comparação dos eventos existentes provou que
o histórico foi preservado.

A revisão estática encontrou e a implementação corrigiu a perda da sessão
cifrada quando a inicialização não conseguia renovar o token offline; a
exposição do cliente Supabase na fachada; e o CTA para cadastro com senha
desativado. A reconexão agora revalida antes de buscar perfil, inclusive com
consentimento previamente carregado, retoma após falha transitória e limita
eventos de sessão gerados pela própria renovação. O runtime gerenciado pelo
bootstrap também é exercitado pelos testes, além dos casos com injeção.
O recheck e os gates do código passaram em `cb6a2da`; isso não fecha a prova nativa.

A tentativa de reproduzir a inicialização com o cliente auth-js real dentro
do Jest excedeu o timeout no lock de inicialização. Esse teste instável foi
retirado; as regressões determinísticas usam a porta com o comportamento
confirmado no source da versão 2.119.2. Esse resultado não é apresentado como
execução do SDK contra a rede; as provas reais de Auth e nativas são separadas.

## Limites de aceite

O build Android e os exports não substituem execução no dispositivo. O harness
usou Auth/JWT/banco/handlers reais e fakes declarados de rate limit e marcador
de exclusão; não validou Upstash/CDN. O app permaneceu no Expo DevLauncher
aguardando a URL do projeto Metro. Não houve fluxo de login aprovado pelo Maestro.
O APK de fixture apontava para um harness local que foi encerrado; não deve ser
entregue aos alunos como app configurado. Usuários/mensagens de teste e processos
nativos próprios foram limpos. Os artefatos privados não fazem parte do repositório.
Contas externas, assinatura EAS, lojas e publicação permanecem no checklist
do app derivado, conforme `base-app.md` §2.
