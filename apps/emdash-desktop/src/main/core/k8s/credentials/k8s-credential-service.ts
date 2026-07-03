import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';

export class K8sCredentialService {
  private tokenSecretKey(connectionId: string): string {
    return `k8s:${connectionId}:token`;
  }

  async storeToken(connectionId: string, token: string): Promise<void> {
    try {
      await encryptedAppSecretsStore.setSecret(this.tokenSecretKey(connectionId), token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to store token for connection ${connectionId}: ${message}`);
    }
  }

  async getToken(connectionId: string): Promise<string | null> {
    try {
      return await encryptedAppSecretsStore.getSecret(this.tokenSecretKey(connectionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to retrieve token for connection ${connectionId}: ${message}`);
    }
  }

  async deleteToken(connectionId: string): Promise<void> {
    try {
      await encryptedAppSecretsStore.deleteSecret(this.tokenSecretKey(connectionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete token for connection ${connectionId}: ${message}`);
    }
  }

  async hasToken(connectionId: string): Promise<boolean> {
    try {
      const credential = await encryptedAppSecretsStore.getSecret(
        this.tokenSecretKey(connectionId)
      );
      return credential !== null;
    } catch {
      return false;
    }
  }

  async storeCredentials(connectionId: string, credentials: { token?: string }): Promise<void> {
    const operations: Promise<void>[] = [];
    if (credentials.token) {
      operations.push(this.storeToken(connectionId, credentials.token));
    }
    if (operations.length > 0) {
      await Promise.all(operations);
    }
  }

  async deleteAllCredentials(connectionId: string): Promise<void> {
    await Promise.all([this.deleteToken(connectionId).catch(() => {})]);
  }
}

export const k8sCredentialService = new K8sCredentialService();
