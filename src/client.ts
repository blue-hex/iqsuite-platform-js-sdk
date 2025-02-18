import axios, {
    AxiosInstance,
    AxiosResponse,
    AxiosRequestHeaders,
    AxiosHeaders,
  } from "axios";  
import FormData from "form-data";
import {
  User,
  Index,
  DocumentListResponse,
  TaskResponse,
  TaskStatus,
  InstantRagResponse,
  InstantRagQueryResponse,
  WebhookListResponse,
  WebhookResponse,
  WebhookDeleteResponse,
  AuthenticationError,
  APIError,
  IQSuiteException,
} from "./types";
import { getMimeType } from "./utils";

interface IQSuiteClientOptions {
  apiKey: string;
  baseUrl?: string;
  verifySsl?: boolean;
}

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/bmp",
]);

export class IQSuiteClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor({
      apiKey,
      baseUrl = "https://iqsuite.ai/api/v1",
      verifySsl = true,
  }: IQSuiteClientOptions) {
      this.baseUrl = baseUrl.replace(/\/$/, "");

      const headers: AxiosHeaders = new AxiosHeaders({
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      });

      const httpsAgent = verifySsl
          ? undefined
          : new (require("https").Agent)({
                rejectUnauthorized: false,
            });

      this.client = axios.create({
          baseURL: this.baseUrl,
          headers,
          httpsAgent,
      });
  }

  private async handleResponse<T>(response: AxiosResponse): Promise<T> {
      const data = response.data;

      if (data.error) {
          throw new APIError(`API error: ${data.error}`, response.status, response);
      }

      if (data.data) {
          return data.data as T;
      }

      return data as T;
  }

  private handleError(error: unknown): never {
    if (axios.isAxiosError(error) && error.response) {
      const status = error.response.status;
      const message = error.response.data?.error || error.message;
  
      if (status === 401) {
        throw new AuthenticationError("Invalid API key");
      }
  
      if (status === 422) {
        const errorMessage = error.response.data?.message || message;
        throw new APIError(
          `Validation error: ${errorMessage}`,
          status,
          error.response
        );
      }
  
      throw new APIError(
        `HTTP ${status} error: ${message}`,
        status,
        error.response
      );
    } else if (error instanceof IQSuiteException) {
      throw error;
    } else if (error instanceof Error) {
      throw new APIError(`Network error: ${error.message}`);
    }
  
    throw new APIError(`An unknown error occurred`);
  }
  

  private validateMimeType(filename: string): string {
      const mimeType = getMimeType(filename);
      if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
          throw new Error(
              `Unsupported file type: ${mimeType}. Supported types are: PDF, DOC, DOCX, PPT, PPTX, JPG, PNG, TIFF, BMP`
          );
      }
      return mimeType;
  }

  async getUser(): Promise<User> {
      try {
          const response = await this.client.get("/user");
          return this.handleResponse<User>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async listIndexes(): Promise<Index[]> {
      try {
          const response = await this.client.get("/index");
          return this.handleResponse<Index[]>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async getDocuments(indexId: string): Promise<DocumentListResponse> {
      try {
          const response = await this.client.get("/index/get-all-documents", {
              params: { index: indexId },
          });
          return this.handleResponse<DocumentListResponse>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async createIndex(
    document: Buffer | Blob,
    filename: string
  ): Promise<TaskResponse> {
    try {
      const mimeType = this.validateMimeType(filename);
  
      const formData = new FormData();
      formData.append("document", document, {
        filename,
        contentType: mimeType,
      });
  
      const headers = AxiosHeaders.from({
        ...this.client.defaults.headers.common,
        ...formData.getHeaders(),
      });
  
      headers.set("Authorization", this.client.defaults.headers.common['Authorization']);
  
      const response = await this.client.post("/index/create", formData, {
        headers,
      });
      
      const taskResponse: TaskResponse = {
        task_id: response.data.task_id,
        data: {
          message: response.data.message || "",
          task_id: response.data.task_id,
          check_status: response.data.check_status || ""
        }
      };
      return taskResponse;
    } catch (error) {
      throw this.handleError(error);
    }
  }
  

  async addDocument(
      indexId: string,
      document: Buffer | Blob,
      filename: string
  ): Promise<TaskResponse> {
      try {
          const mimeType = this.validateMimeType(filename);

          const formData = new FormData();
          formData.append("document", document, {
              filename,
              contentType: mimeType,
          });
          formData.append("index", indexId);

          const headers = AxiosHeaders.from({
            ...this.client.defaults.headers.common,
            ...formData.getHeaders(),
          });

          const response = await this.client.post("/index/add-document", formData, {
              headers,
          });
          return this.handleResponse<TaskResponse>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async createIndexAndPoll(
    document: Buffer | Blob,
    filename: string,
    maxRetries: number = 5,
    pollInterval: number = 5000
  ): Promise<[TaskResponse, TaskStatus]> {
    try {
      const response = await this.createIndex(document, filename);
      const taskId = response.data.task_id;
  
      let retries = 0;
      while (retries < maxRetries) {
        const status = await this.getTaskStatus(taskId);
        
        if (status.status === "completed") {
          return [response, status];
        } else if (status.status === "failed") {
          throw new APIError(`Task failed with status: ${status.status}`);
        }
  
        await this.delay(pollInterval);
        retries++;
      }
  
      throw new APIError(
        `Maximum retries (${maxRetries}) reached while polling task status`
      );
    } catch (error) {
      if (error instanceof IQSuiteException) {
        throw error;
      }
      throw new APIError(`Error in createIndexAndPoll: ${error}`);
    }
  }

  async addDocumentAndPoll(
    indexId: string,
    document: Buffer | Blob,
    filename: string,
    maxRetries: number = 5,
    pollInterval: number = 5000
  ): Promise<[TaskResponse, TaskStatus]> {
    try {
      const response = await this.addDocument(indexId, document, filename);
      const taskId = response.data.task_id; // Updated here
  
      let retries = 0;
      while (retries < maxRetries) {
        const status = await this.getTaskStatus(taskId);
        if (status.status === "completed") {
          return [response, status];
        } else if (status.status === "failed") {
          throw new APIError(`Task failed with status: ${status.status}`);
        }
  
        await this.delay(pollInterval);
        retries++;
      }
  
      throw new APIError(
        `Maximum retries (${maxRetries}) reached while polling task status`
      );
    } catch (error) {
      if (error instanceof IQSuiteException) {
        throw error;
      }
      throw new APIError(`Error in addDocumentAndPoll: ${error}`);
    }
  }
  

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
      try {
          const response = await this.client.get(`/create-index/task-status/${taskId}`);
          return this.handleResponse<TaskStatus>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async retrieve(indexId: string, query: string): Promise<any> {
      try {
          const response = await this.client.post("/index/retrieve", {
              index: indexId,
              query,
          });
          return this.handleResponse<any>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async search(indexId: string, query: string): Promise<any> {
      try {
          const response = await this.client.post("/index/search", {
              index: indexId,
              query,
          });
          return this.handleResponse<any>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async deleteDocument(indexId: string, documentId: string): Promise<any> {
      try {
          const response = await this.client.post("/index/delete-document", {
              index: indexId,
              document: documentId,
          });
          return this.handleResponse<any>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async createInstantRag(context: string): Promise<InstantRagResponse> {
      try {
          const response = await this.client.post("/index/instant/create", {
              context,
          });
          return this.handleResponse<InstantRagResponse>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async queryInstantRag(
      indexId: string,
      query: string
  ): Promise<InstantRagQueryResponse> {
      try {
          const response = await this.client.post("/index/instant/query", {
              index: indexId,
              query,
          });
          return this.handleResponse<InstantRagQueryResponse>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async listWebhooks(): Promise<WebhookListResponse> {
      try {
          const response = await this.client.get("/webhooks");
          return this.handleResponse<WebhookListResponse>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async createWebhook(
      url: string,
      name: string,
      secret: string,
      enabled: boolean
  ): Promise<WebhookResponse> {
      try {
          const payload = {
              url,
              name,
              enabled,
              secret,
          };
          const response = await this.client.post("/webhooks", payload);
          return this.handleResponse<WebhookResponse>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async updateWebhook(
      webhookId: string,
      url: string,
      name: string,
      enabled: boolean
  ): Promise<WebhookResponse> {
      try {
          const payload = {
              webhook_id: webhookId,
              url,
              name,
              enabled,
          };
          const response = await this.client.post("/webhooks/update", payload);
          return this.handleResponse<WebhookResponse>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  async deleteWebhook(webhookId: string): Promise<WebhookDeleteResponse> {
      try {
          const payload = { webhook_id: webhookId };
          const response = await this.client.post("/webhooks/delete", payload);
          return this.handleResponse<WebhookDeleteResponse>(response);
      } catch (error) {
          throw this.handleError(error);
      }
  }

  private delay(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
export { InstantRagQueryResponse, TaskStatus, TaskResponse, DocumentListResponse, User, Index, APIError, AuthenticationError, IQSuiteException };

