export { accountApi, createAccountApi } from './api/account-api';
export {
  createSupabaseAuthAdapter,
  type SupabaseAuthAdapter,
  type SupabaseAuthAdapterOptions,
} from './adapters/supabase-auth-adapter';
export {
  createAuthController,
  normalizeEmail,
  validateOtpCode,
  validatePassword,
} from './model/auth-controller';
export type {
  AccountApiPort,
  AuthAccessStatus,
  AuthCodePurpose,
  AuthController,
  AuthControllerDependencies,
  AuthFieldError,
  AuthFlowSnapshot,
  AuthResult,
  AuthSnapshot,
  AuthTransportPort,
  EmailChangeAddress,
  EmailCodePurpose,
  FieldValidation,
  IdentityLifecycleSink,
  PasswordChangePurpose,
  PasswordSetupPurpose,
  SignOutScope,
  StepUpMethod,
} from './model/auth-contracts';
