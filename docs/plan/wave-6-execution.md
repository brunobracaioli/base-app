# Execução da onda 6 — Login por e-mail

## Base e decisões

Branch `feat/w6-email-auth`, base com W5 concluída. Worktree persistente em
`.worktrees/w6` após reinício que limpou `/tmp`; código do spike foi recuperado da
KVM. O dono autorizou execução contínua das ondas restantes, sem push/deploy.

Spikes locais em GoTrue v2.198.0 e Mailpit: ramos de corpo/assunto funcionaram nos
cinco tipos e três idiomas, com fallback seguro para locale inválida. O teste de
cópia encontrou e corrigiu um corpo EN vazio; OTP, prazo e aviso de não
compartilhamento passaram em EN reauth e nos seis códigos de troca de e-mail
PT/EN/ES. Cadastro com senha mantém a senha após confirmação: Plano B selecionado.
O manager aplicou a migration e pgTAP passou em 14 arquivos/294 assertions,
incluindo as seis assertions W6. O teste pré-sequestro local rejeitou o sign-in do
atacante antes (`email_not_confirmed`) e depois (`invalid_credentials`) da
confirmação da vítima; OTP-only criou senha depois e conseguiu entrar.

Troca de e-mail confirmou as duas caixas e os avisos localizados chegaram ao
endereço antigo em PT/EN/ES. Sessão recente aceita mudança de senha sem `nonce`:
o app sempre exige `reauthenticate()` e envia o nonce, mas chamada direta ao Auth
permanece risco R-ID-4. Avisos localizados de senha chegaram em PT/EN/ES. Dez erros
não invalidaram o código correto e IPv6 `/64` não foi comprovado: OTP 10/300/10,
sem relaxar controles. Resultados detalhados estão em identity-and-auth §8, ADR
0004 e [`wave-6-auth-spikes.md`](wave-6-auth-spikes.md).

## Plano e provas de aceite

1. **Banco/config/templates:** migration aditiva `clear_unverified_password`,
   registry fechado de Auth, pgTAP e configuração 10/300/10 gerada. Prova real:
   senha do atacante deixa de funcionar depois do código da vítima. Templates
   e subject com guard de tipo; nenhuma locale, senha ou OTP em logs.
2. **Modelo/contrato interno:** `features/auth/model` recebe portas, estado em
   memória, validação de e-mail/senha/código, cooldown e comandos de fluxo;
   `features/auth/api` consome os contratos existentes de me/consents. Testes
   de transições, enumeração, replay de gesto, reset e troca/reauth. Publicar
   interfaces antes dos consumidores; preservar a fachada de extensões.
3. **SDK/sessão:** `features/auth/adapters` usa Supabase JS, Noble AES-GCM,
   SecureStore e AsyncStorage. Testes de cifragem, AAD, tag/versão/chave perdida,
   concorrência, logout, sessão antiga versus nova, captura/step-up de outra
   conta, refresh foreground e withCaptcha. Chaves só geradas em runtime.
4. **UI/composição:** telas finas por fluxo, rotas sem efeitos de montagem,
   i18n pt-BR/en/es, code/reauth com proteção de captura, termos e perfil.
   RNTL verifica gestos, gates, inputs nunca em params e mensagens genéricas.
   Integração do core runtime preserva os providers e contratos de W3/W5.
5. **Verificação:** lint, tipos, testes, arquitetura, contrato/config/tipos sem
   drift, scans, build/exports, pgTAP e Auth/Mailpit reais. Maestro será executado
   se houver dispositivo/ambiente nativo; resultado indisponível não vira sucesso.

## Frentes independentes

- Spike/banco/config/ADRs: dono exclusivo dos arquivos Supabase e guards.
- Modelo e API: publica portas e tipos; não altera SDK, UI ou providers.
- SDK e composição: consome portas; dono dos manifests/lockfile e do wiring.
- UI e textos: consome controller público; não importa cliente Supabase bruto.

Os coders começam em Luna/xhigh. Modelos/SDK/UI podem avançar em paralelo após
as decisões dos spikes e a barreira de interfaces. Cadastros externos, DNS,
notificações de produção e EAS/lojas permanecem etapas do derivado.
