import { PartitionKeyRange } from "./client/Container/PartitionKeyRange";
import { Resource } from "./client/Resource";
import { Constants, HTTPMethod, OperationType, ResourceType } from "./common/constants";
import { getIdFromLink, getPathFromLink, parseLink } from "./common/helper";
import { StatusCodes, SubStatusCodes } from "./common/statusCodes";
import { CosmosClientOptions } from "./CosmosClientOptions";
import { ConnectionPolicy, ConsistencyLevel, DatabaseAccount } from "./documents";
import { GlobalEndpointManager } from "./globalEndpointManager";
import { executePlugins, PluginOn } from "./plugins/Plugin";
import { FetchFunctionCallback, SqlQuerySpec } from "./queryExecutionContext";
import { CosmosHeaders } from "./queryExecutionContext/CosmosHeaders";
import { QueryIterator } from "./queryIterator";
import { FeedOptions, RequestOptions, Response } from "./request";
import { ErrorResponse } from "./request";
import { InternalOperationStats } from "./request/OperationStatistics";
import { getHeaders } from "./request/request";
import { RequestContext } from "./request/RequestContext";
import { request as executeRequest } from "./request/RequestHandler";
import { SessionContainer } from "./session/sessionContainer";
import { SessionContext } from "./session/SessionContext";

/**
 * @hidden
 * @ignore
 */
export class ClientContext {
  private readonly sessionContainer: SessionContainer;
  private connectionPolicy: ConnectionPolicy;

  public partitionKeyDefinitionCache: { [containerUrl: string]: any }; // TODO: ParitionKeyDefinitionCache
  public constructor(
    private cosmosClientOptions: CosmosClientOptions,
    private globalEndpointManager: GlobalEndpointManager
  ) {
    this.connectionPolicy = cosmosClientOptions.connectionPolicy;
    this.sessionContainer = new SessionContainer();
    this.partitionKeyDefinitionCache = {};
  }
  /** @ignore */
  public async read<T>(
    path: string,
    resourceType: ResourceType,
    resourceId: string,
    options: RequestOptions = {}
  ): Promise<Response<T & Resource>> {
    const request: RequestContext = {
      globalEndpointManager: this.globalEndpointManager,
      requestAgent: this.cosmosClientOptions.agent,
      connectionPolicy: this.connectionPolicy,
      method: HTTPMethod.get,
      path,
      operationType: OperationType.Read,
      client: this,
      resourceId,
      options,
      resourceType,
      operationStatistics: new InternalOperationStats(resourceType, OperationType.Read, path, ""), // TODO: activity id
      plugins: this.cosmosClientOptions.plugins
    };
    try {
      request.headers = await this.buildHeaders(request);
      this.applySessionToken(request);

      // read will use ReadEndpoint since it uses GET operation
      request.endpoint = await this.globalEndpointManager.resolveServiceEndpoint(request);
      const response = await executePlugins(request, executeRequest, PluginOn.operation);
      this.captureSessionToken(undefined, path, OperationType.Read, response.headers);
      request.operationStatistics.complete();
      return response;
    } catch (err) {
      request.operationStatistics.fail();
      this.captureSessionToken(err, path, OperationType.Upsert, (err as ErrorResponse).headers);
      throw err;
    }
  }

  public async queryFeed<T>(
    path: string,
    resourceType: ResourceType,
    resourceId: string,
    resultFn: (result: { [key: string]: any }) => any[], // TODO: any
    query: SqlQuerySpec | string,
    options: FeedOptions,
    partitionKeyRangeId?: string
  ): Promise<Response<T & Resource>> {
    // Query operations will use ReadEndpoint even though it uses
    // GET(for queryFeed) and POST(for regular query operations)

    const request: RequestContext = {
      globalEndpointManager: this.globalEndpointManager,
      requestAgent: this.cosmosClientOptions.agent,
      connectionPolicy: this.connectionPolicy,
      method: HTTPMethod.get,
      path,
      operationType: OperationType.Query,
      client: this,
      partitionKeyRangeId,
      resourceId,
      resourceType,
      options,
      body: query,
      plugins: this.cosmosClientOptions.plugins,
      operationStatistics: undefined // TODO: design doesn't really make sense for query as much...
    };

    if (query !== undefined) {
      request.method = HTTPMethod.post;
    }
    request.endpoint = await this.globalEndpointManager.resolveServiceEndpoint(request);
    request.headers = await this.buildHeaders(request);
    if (query !== undefined) {
      request.headers[Constants.HttpHeaders.IsQuery] = "true";
      request.headers[Constants.HttpHeaders.ContentType] = Constants.MediaTypes.QueryJson;
      if (typeof query === "string") {
        request.body = { query }; // Converts query text to query object.
      }
    }
    this.applySessionToken(request);
    const response = await executeRequest(request);
    this.captureSessionToken(undefined, path, OperationType.Query, response.headers);
    return this.processQueryFeedResponse(response, !!query, resultFn);
  }

  public queryPartitionKeyRanges(collectionLink: string, query?: string | SqlQuerySpec, options?: FeedOptions) {
    const path = getPathFromLink(collectionLink, ResourceType.pkranges);
    const id = getIdFromLink(collectionLink);
    const cb: FetchFunctionCallback = innerOptions => {
      return this.queryFeed(path, ResourceType.pkranges, id, result => result.PartitionKeyRanges, query, innerOptions);
    };
    return new QueryIterator<PartitionKeyRange>(this, query, options, cb);
  }

  public async delete<T>(
    path: string,
    resourceType: ResourceType,
    resourceId: string,
    options: RequestOptions = {}
  ): Promise<Response<T & Resource>> {
    const request: RequestContext = {
      globalEndpointManager: this.globalEndpointManager,
      requestAgent: this.cosmosClientOptions.agent,
      connectionPolicy: this.connectionPolicy,
      method: HTTPMethod.delete,
      client: this,
      operationType: OperationType.Delete,
      path,
      resourceType,
      options,
      resourceId,
      plugins: this.cosmosClientOptions.plugins,
      operationStatistics: new InternalOperationStats(resourceType, OperationType.Delete, path, "") // TODO: activity id
    };
    try {
      request.headers = await this.buildHeaders(request);
      this.applySessionToken(request);
      // deleteResource will use WriteEndpoint since it uses DELETE operation
      request.endpoint = await this.globalEndpointManager.resolveServiceEndpoint(request);
      const response = await executePlugins(request, executeRequest, PluginOn.operation);
      if (parseLink(path).type !== "colls") {
        this.captureSessionToken(undefined, path, OperationType.Delete, response.headers);
      } else {
        this.clearSessionToken(path);
      }
      request.operationStatistics.complete();
      return response;
    } catch (err) {
      request.operationStatistics.fail();
      this.captureSessionToken(err, path, OperationType.Upsert, (err as ErrorResponse).headers);
      throw err;
    }
  }

  public async create<T, U = T>(
    body: T,
    path: string,
    resourceType: ResourceType,
    resourceId: string,
    options: RequestOptions = {}
  ): Promise<Response<T & U & Resource>> {
    const request: RequestContext = {
      globalEndpointManager: this.globalEndpointManager,
      requestAgent: this.cosmosClientOptions.agent,
      connectionPolicy: this.connectionPolicy,
      method: HTTPMethod.post,
      client: this,
      operationType: OperationType.Create,
      path,
      resourceType,
      resourceId,
      body,
      options,
      plugins: this.cosmosClientOptions.plugins,
      operationStatistics: new InternalOperationStats(resourceType, OperationType.Create, path, "") // TODO: activity id
    };
    try {
      request.headers = await this.buildHeaders(request);
      // create will use WriteEndpoint since it uses POST operation
      this.applySessionToken(request);

      request.endpoint = await this.globalEndpointManager.resolveServiceEndpoint(request);
      const response = await executePlugins(request, executeRequest, PluginOn.operation);
      this.captureSessionToken(undefined, path, OperationType.Create, response.headers);
      request.operationStatistics.complete();
      return response;
    } catch (err) {
      request.operationStatistics.fail();
      this.captureSessionToken(err, path, OperationType.Upsert, (err as ErrorResponse).headers);
      throw err;
    }
  }

  private processQueryFeedResponse(
    res: Response<any>,
    isQuery: boolean,
    resultFn: (result: { [key: string]: any }) => any[]
  ): Response<any> {
    if (isQuery) {
      return {
        result: resultFn(res.result),
        headers: res.headers,
        statusCode: res.statusCode,
        operationStatistics: res.operationStatistics
      };
    } else {
      const newResult = resultFn(res.result).map((body: any) => body);
      return {
        result: newResult,
        headers: res.headers,
        statusCode: res.statusCode,
        operationStatistics: res.operationStatistics
      };
    }
  }

  private applySessionToken(requestContext: RequestContext) {
    const request = this.getSessionParams(requestContext.path);

    if (requestContext.headers && requestContext.headers[Constants.HttpHeaders.SessionToken]) {
      return;
    }

    const sessionConsistency: ConsistencyLevel = requestContext.headers[
      Constants.HttpHeaders.ConsistencyLevel
    ] as ConsistencyLevel;
    if (!sessionConsistency) {
      return;
    }

    if (sessionConsistency !== ConsistencyLevel.Session) {
      return;
    }

    if (request.resourceAddress) {
      const sessionToken = this.sessionContainer.get(request);
      if (sessionToken) {
        requestContext.headers[Constants.HttpHeaders.SessionToken] = sessionToken;
      }
    }
  }

  public async replace<T>(
    body: any,
    path: string,
    resourceType: ResourceType,
    resourceId: string,
    options: RequestOptions = {}
  ): Promise<Response<T & Resource>> {
    const request: RequestContext = {
      globalEndpointManager: this.globalEndpointManager,
      requestAgent: this.cosmosClientOptions.agent,
      connectionPolicy: this.connectionPolicy,
      method: HTTPMethod.put,
      client: this,
      operationType: OperationType.Replace,
      path,
      resourceType,
      body,
      resourceId,
      options,
      plugins: this.cosmosClientOptions.plugins,
      operationStatistics: new InternalOperationStats(resourceType, OperationType.Replace, path, "") // TODO: activity id
    };
    try {
      request.headers = await this.buildHeaders(request);
      this.applySessionToken(request);

      // replace will use WriteEndpoint since it uses PUT operation
      request.endpoint = await this.globalEndpointManager.resolveServiceEndpoint(request);
      const response = await executePlugins(request, executeRequest, PluginOn.operation);
      this.captureSessionToken(undefined, path, OperationType.Replace, response.headers);
      request.operationStatistics.complete();
      return response;
    } catch (err) {
      request.operationStatistics.fail();
      this.captureSessionToken(err, path, OperationType.Upsert, (err as ErrorResponse).headers);
      throw err;
    }
  }

  public async upsert<T, U = T>(
    body: T,
    path: string,
    resourceType: ResourceType,
    resourceId: string,
    options: RequestOptions = {}
  ): Promise<Response<T & U & Resource>> {
    const request: RequestContext = {
      globalEndpointManager: this.globalEndpointManager,
      requestAgent: this.cosmosClientOptions.agent,
      connectionPolicy: this.connectionPolicy,
      method: HTTPMethod.post,
      client: this,
      operationType: OperationType.Upsert,
      path,
      resourceType,
      body,
      resourceId,
      options,
      plugins: this.cosmosClientOptions.plugins,
      operationStatistics: new InternalOperationStats(resourceType, OperationType.Upsert, path, "") // TODO: activity id
    };
    try {
      request.headers = await this.buildHeaders(request);
      request.headers[Constants.HttpHeaders.IsUpsert] = true;
      this.applySessionToken(request);

      // upsert will use WriteEndpoint since it uses POST operation
      request.endpoint = await this.globalEndpointManager.resolveServiceEndpoint(request);
      const response = await executePlugins(request, executeRequest, PluginOn.operation);
      this.captureSessionToken(undefined, path, OperationType.Upsert, response.headers);
      request.operationStatistics.complete();
      return response;
    } catch (err) {
      request.operationStatistics.fail();
      this.captureSessionToken(err, path, OperationType.Upsert, (err as ErrorResponse).headers);
      throw err;
    }
  }

  public async execute<T>(
    sprocLink: string,
    params?: any[], // TODO: any
    options: RequestOptions = {}
  ): Promise<Response<T>> {
    // Accept a single parameter or an array of parameters.
    // Didn't add type annotation for this because we should legacy this behavior
    if (params !== null && params !== undefined && !Array.isArray(params)) {
      params = [params];
    }
    const path = getPathFromLink(sprocLink);
    const id = getIdFromLink(sprocLink);

    const request: RequestContext = {
      globalEndpointManager: this.globalEndpointManager,
      requestAgent: this.cosmosClientOptions.agent,
      connectionPolicy: this.connectionPolicy,
      method: HTTPMethod.post,
      client: this,
      operationType: OperationType.Execute,
      path,
      resourceType: ResourceType.sproc,
      options,
      resourceId: id,
      body: params,
      plugins: this.cosmosClientOptions.plugins,
      operationStatistics: new InternalOperationStats(ResourceType.sproc, OperationType.Execute, path, "") // TODO: activity id
    };
    try {
      request.headers = await this.buildHeaders(request);
      // executeStoredProcedure will use WriteEndpoint since it uses POST operation
      request.endpoint = await this.globalEndpointManager.resolveServiceEndpoint(request);
      const response = executePlugins(request, executeRequest, PluginOn.operation);
      request.operationStatistics.complete();
      return response;
    } catch (err) {
      request.operationStatistics.fail();
      throw err;
    }
  }

  /**
   * Gets the Database account information.
   * @param {string} [options.urlConnection]   - The endpoint url whose database account needs to be retrieved. \
   * If not present, current client's url will be used.
   */
  public async getDatabaseAccount(options: RequestOptions = {}): Promise<Response<DatabaseAccount>> {
    const endpoint = options.urlConnection || this.cosmosClientOptions.endpoint;
    const request: RequestContext = {
      endpoint,
      globalEndpointManager: this.globalEndpointManager,
      requestAgent: this.cosmosClientOptions.agent,
      connectionPolicy: this.connectionPolicy,
      method: HTTPMethod.get,
      client: this,
      operationType: OperationType.Read,
      path: "",
      resourceType: ResourceType.none,
      options,
      plugins: this.cosmosClientOptions.plugins,
      operationStatistics: new InternalOperationStats(ResourceType.none, OperationType.Read, "", "") // TODO: activity id
    };

    try {
      request.headers = await this.buildHeaders(request);
      // await options.beforeOperation({ endpoint, request, headers: requestHeaders });
      const { result, headers, statusCode, operationStatistics } = await executePlugins(
        request,
        executeRequest,
        PluginOn.operation
      );

      const databaseAccount = new DatabaseAccount(result, headers);
      request.operationStatistics.complete();
      return { result: databaseAccount, headers, statusCode, operationStatistics };
    } catch (err) {
      request.operationStatistics.fail();
      throw err;
    }
  }

  public getWriteEndpoint(): Promise<string> {
    return this.globalEndpointManager.getWriteEndpoint();
  }

  public getReadEndpoint(): Promise<string> {
    return this.globalEndpointManager.getReadEndpoint();
  }

  private captureSessionToken(
    err: ErrorResponse,
    path: string,
    operationType: OperationType,
    resHeaders: CosmosHeaders
  ) {
    const request = this.getSessionParams(path);
    request.operationType = operationType;
    if (
      !err ||
      (!this.isMasterResource(request.resourceType) &&
        (err.code === StatusCodes.PreconditionFailed ||
          err.code === StatusCodes.Conflict ||
          (err.code === StatusCodes.NotFound && err.substatus !== SubStatusCodes.ReadSessionNotAvailable)))
    ) {
      this.sessionContainer.set(request, resHeaders);
    }
  }

  public clearSessionToken(path: string) {
    const request = this.getSessionParams(path);
    this.sessionContainer.remove(request);
  }

  private getSessionParams(resourceLink: string): SessionContext {
    const resourceId: string = null;
    let resourceAddress: string = null;
    const parserOutput = parseLink(resourceLink);

    resourceAddress = parserOutput.objectBody.self;

    const resourceType = parserOutput.type;
    return {
      resourceId,
      resourceAddress,
      resourceType,
      isNameBased: true
    };
  }

  private isMasterResource(resourceType: string): boolean {
    if (
      resourceType === Constants.Path.OffersPathSegment ||
      resourceType === Constants.Path.DatabasesPathSegment ||
      resourceType === Constants.Path.UsersPathSegment ||
      resourceType === Constants.Path.PermissionsPathSegment ||
      resourceType === Constants.Path.TopologyPathSegment ||
      resourceType === Constants.Path.DatabaseAccountPathSegment ||
      resourceType === Constants.Path.PartitionKeyRangesPathSegment ||
      resourceType === Constants.Path.CollectionsPathSegment
    ) {
      return true;
    }

    return false;
  }

  private buildHeaders(requestContext: RequestContext) {
    return getHeaders({
      authOptions: this.cosmosClientOptions.auth,
      defaultHeaders: { ...this.cosmosClientOptions.defaultHeaders, ...requestContext.options.initialHeaders },
      verb: requestContext.method,
      path: requestContext.path,
      resourceId: requestContext.resourceId,
      resourceType: requestContext.resourceType,
      options: requestContext.options,
      partitionKeyRangeId: requestContext.partitionKeyRangeId,
      useMultipleWriteLocations: this.connectionPolicy.useMultipleWriteLocations
    });
  }
}
