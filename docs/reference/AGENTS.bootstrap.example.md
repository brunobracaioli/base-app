# Instruções do produto derivado

Este arquivo é um modelo. Na cópia do aluno, crie `AGENTS.bootstrap.md` na raiz
com as decisões reais do produto. Preserve um arquivo de instruções existente;
campos ainda desconhecidos são perguntas em aberto, não fatos a inventar.

## Objetivo do produto

- Ideia, público e problema: registrar a descrição fornecida pelo usuário.
- Primeiro fluxo útil: registrar o resultado que ele quer implementar primeiro.
- Fora do escopo atual: registrar somente limites combinados com o usuário.

## Como usar a base

- Este projeto deriva do base-app. O `README.md` descreve o ponto de partida;
  confira o código atual antes de afirmar que uma funcionalidade está disponível.
- O objetivo é desenvolver o produto acima. Não executar automaticamente o
  roadmap histórico do núcleo em `docs/plan/implementation-waves.md`.
- Criar/manter as specs do produto em `docs/specs/` e um plano próprio em
  `docs/plan/`, com nomes que não sobrescrevam as referências da base. Reutilizar
  os documentos do produto se já existirem.
- Aplicar as regras de arquitetura, segurança, contratos e testes de `AGENTS.md`.
  Este arquivo muda a prioridade do trabalho, não remove esses controles.
- Personalizar nome, IDs, scheme, idiomas e métodos em
  `packages/config/src/product.config.ts`; não espalhar esses dados pelo código.
- Usar os pontos de extensão documentados para funcionalidades novas. Só alterar
  o núcleo quando a necessidade estiver justificada e coberta por spec/testes.

## Configuração e validação

- Informar quais integrações o primeiro fluxo realmente precisa. Contas,
  credenciais e URLs são fornecidas/configuradas pelo dono do produto, fora do Git.
- Nunca colocar segredos em `EXPO_PUBLIC_*` ou `NEXT_PUBLIC_*`.
- Distinguir código implementado de serviço configurado e de teste em dispositivo.
- Registrar os comandos executados e suas limitações. Não declarar pronto um
  fluxo que só tem tela, mock ou configuração de exemplo.
- Push, publicação, deploy, migrations hospedadas e gastos exigem instrução
  explícita do usuário para a ação correspondente.
