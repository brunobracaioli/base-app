# Executar a bateria local ou numa KVM

O executor do projeto é `pnpm ci:local`, conforme o ADR 0015. GitHub Actions
não é usado. O gate executa os comandos da onda vigente e grava um recibo
associado ao commit/tree; uma execução parcial ou com alterações de fonte
não comprova o commit publicado.

## Preparar as ferramentas

Use o Node indicado em `.nvmrc` e o pnpm de `packageManager`. As versões dos
scanners ficam em `packages/tooling/src/ci/tool-versions.ts`:

| Ferramenta | Versão | Caminho opcional |
| --- | --- | --- |
| pnpm | 12.23.0 | `CI_LOCAL_PNPM_BIN` |
| Semgrep | 1.186.0 | `CI_LOCAL_SEMGREP_BIN` |
| Gitleaks | 8.30.1 | `CI_LOCAL_GITLEAKS_BIN` |
| OSV-Scanner | 2.7.1 | `CI_LOCAL_OSV_SCANNER_BIN` |
| zizmor | 1.33.1 | `CI_LOCAL_ZIZMOR_BIN` |

Os caminhos são configuração não secreta. Sem eles, os executáveis são
procurados no `PATH`. Instale os releases fixados de suas fontes oficiais e
confira checksums; o runner não baixa executáveis arbitrários nem aceita
versões diferentes silenciosamente. Semgrep/zizmor podem ser instalados em
ambientes isolados de Python por `uv`; Gitleaks e OSV têm binários de release.

## Executar

```bash
nvm install
nvm use
corepack enable
pnpm ci:local
```

O comando faz a instalação congelada antes das verificações. Nenhuma conta
Supabase, credencial de nuvem ou chave de API é necessária para a onda 0.
O runner não carrega `.env` e limita o ambiente recebido pelos subprocessos.

Com alterações locais, o recibo informa a condição e não atesta o SHA.
Para publicar evidência, faça commit das mudanças e rode sobre checkout limpo.
Confirme `result: passed`, `attestableCommit: true`, o SHA do commit e a tree
no recibo. Todos os gates devem ter `passed: true`; a fixture insegura do
zizmor tem exit 14 esperado, que não equivale a ignorar uma falha real.

Logs e recibos ficam em `.artifacts/ci/`, ignorada pelo Git. Não copie secrets
para essa pasta. O status `CI / local` no PR só deve ser publicado depois de
conferir o recibo do SHA exato; nenhum script deste gate publica status remoto.

## Usar uma KVM existente

O mesmo comando pode ser executado numa KVM com as ferramentas fixadas.
O padrão operacional existente é: enviar um `git bundle`, abrir worktree
isolada por commit, executar uma bateria por VM e recolher evidência por tree.
Não enviar `.env`, credencial de GitHub ou chave de nuvem; não reinstalar
máquinas para executar este gate. A conexão e a escolha do host dependem da
configuração externa do operador, não do template público.

Na onda 2, o ambiente de execução precisará de Docker para Supabase/pgTAP.
Esses gates serão incorporados quando as migrations e tipos existirem.
Um recibo da onda 0 não comprova runtime de Auth, banco ou entrega SMTP.
