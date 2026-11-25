export class ProfileOwnerMissingError extends Error {
  constructor() {
    super('The profile owner no longer exists.');
    this.name = 'ProfileOwnerMissingError';
  }
}
