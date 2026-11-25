# Spec — gates locais e em KVM

Status: accepted em 2026-11-24, por instrução do dono. Escopo atual: onda 0.

## Objetivo e decisão

Substituir a execução em GitHub Actions por um comando local reproduzível,
`pnpm ci:local`, também executável numa KVM já existente. Não provisionar servidor,
alterar orçamento ou copiar credenciais para o repositório. Esta decisão substitui
as referências ao executor GitHub Actions na onda 0 e no ADR 0012; os mesmos gates
continuam obrigatórios. GitHub é usado como hospedagem de código e revisão.

## Contrato de execução

- Um único comando executa, em ordem, instalação com lockfile congelado; lint,
  typecheck e testes; arquitetura; formatação; geração e drift de OpenAPI/TOML;
  invariantes Supabase; lint de migrations; allowlist Vercel; regras e scan Semgrep;
  Gitleaks; OSV; e validação estática zizmor do que existir em `.github` e da fixture
  insegura. A fixture insegura deve falhar com o código esperado.
- Falha ou ferramenta ausente encerra com código diferente de zero. Não ignorar
  gates nem transformar erro de infraestrutura em sucesso.
- Node/pnpm seguem `.nvmrc` e `packageManager`. Scanners são fixados nas versões
  já verificadas: Semgrep 1.186.0, Gitleaks 8.30.1, OSV 2.7.1, zizmor 1.33.1.
  Caminhos de binários podem ser fornecidos por configuração não secreta.
- A execução gera recibo JSON e logs em diretório ignorado pelo Git. O recibo
  contém SHA do commit e da tree, estado limpo/sujo, horários, versões, gates e exit codes.
  Apenas execução completa sobre checkout limpo pode comprovar um SHA publicado.
  Execução em checkout sujo pode ajudar o desenvolvimento, mas não atesta o commit.
  Mudança de HEAD/tree ou dos arquivos durante a execução invalida o atestado.
- O runner não lê `.env` nem publica status remotamente. O gerente pode publicar
  um status `CI / local` depois de conferir recibo bem-sucedido do SHA exato.
  Esse status identifica a execução local; nunca se apresenta como GitHub Actions.

## Segurança e limites

- Subprocessos usam argumentos separados, sem `eval`/shell interpolado. Nenhum
  segredo é recebido por argumento, gravado em recibos ou copiado para uma KVM.
  O ambiente dos subprocessos é limitado às variáveis operacionais necessárias;
  tokens e credenciais de nuvem da sessão não são propagados à instalação/testes.
- Retirar o workflow executável de Actions. O recurso Actions do repositório foi
  desativado por instrução do dono; não será reativado por scripts.
- O baseline de código mantém rulesets e a revisão de mudanças. Environments
  específicos de Actions deixam de ser requisito padrão. O doctor pode continuar
  testando baselines que os declarem, mas o template local não exige esses recursos.
- Aprovação humana antes de migrations remotas, release, publicação e deploy
  continua obrigatória. A automação operacional correspondente é escopo de ondas
  futuras; este runner nunca executa essas ações.
- Docker, pgTAP e drift Kysely entram a partir da onda 2, quando seus artefatos
  existirem. Não criar placeholders que retornem sucesso para esses gates.

## Aceite

1. `pnpm ci:local` passa sobre o checkout integrado e limpo, com recibo do SHA real.
2. Teste determinístico prova que uma falha interrompe a sequência e produz recibo
   de falha; checkout sujo nunca produz atestado de commit limpo.
3. Logs/recibo ficam fora do Git; `.env.example` e arquivos secretos não são lidos.
4. OpenAPI/TOML divergentes e fixture zizmor inesperadamente aprovada reprovam.
5. Não há workflow executável em `.github/workflows`; o PR mostra a proveniência
   local da validação e distingue controles de release ainda pendentes.

## Threat model resumido

| Ameaça | Controle |
| --- | --- |
| Resultado antigo apresentado como validação de código novo | SHA e tree capturados; checkout limpo; alteração durante o gate invalida o recibo |
| Dependência de instalação lendo credenciais da sessão | Allowlist de ambiente; `.env` não lido; scripts de instalação e versões continuam limitados |
| Comando malformado/injetado por configuração | Subprocessos com argv, sem shell; etapas declaradas pelo projeto |
| Saída parcial apresentada como sucesso | Fail-fast, exit codes explícitos, atestado apenas com todos os gates aprovados |
| Execução concorrente ou com segredos numa KVM compartilhada | Worktree isolada por commit, uma execução por VM, envio de bundle sem `.env`; uso remoto só quando necessário |
