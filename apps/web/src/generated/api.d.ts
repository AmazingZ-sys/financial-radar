export interface paths {
  "/health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 存活检查 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** @enum {string} */
                status: "ok";
                version: string;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/auth/login": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 管理员登录 */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /** Format: email */
            email: string;
            password: string;
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                /** Format: email */
                email: string;
                role: string;
                csrfToken: string;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/auth/me": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 当前用户 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                /** Format: email */
                email: string;
                role: string;
                csrfToken: string;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/auth/logout": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 退出登录 */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                ok: boolean;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 事件流 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                eventType: string;
                sourceId: string;
                externalId: string;
                title: string;
                description: string;
                /** Format: uri */
                originalUrl: string | null;
                /** Format: date-time */
                sourcePublishedAt: string | null;
                /** Format: date-time */
                firstSeenAt: string;
                /** Format: date-time */
                collectedAt: string;
                /** Format: date-time */
                eventOccurredAt: string | null;
                /** Format: date-time */
                normalizedAt?: string;
                /** Format: date-time */
                detectedAt?: string;
                assets: string[];
                categories: string[];
                chain?: string;
                assetKey?: string;
                metrics?: {
                  [key: string]: number | string | unknown;
                };
                conditionsVerified?: boolean;
                rawDataReference: string;
                fingerprint: string;
                confidence: number;
                /** @enum {string} */
                severity: "P0" | "P1" | "P2" | "P3";
                /** @enum {string} */
                verificationStatus: "UNVERIFIED" | "VERIFIED" | "DISPUTED";
                /** @enum {string} */
                analysisStatus:
                  "PENDING" | "COMPLETED" | "FAILED" | "DISABLED" | "DEFERRED";
                opportunityScore: number;
                riskScore: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                updatedAt: string;
                review?: {
                  /** @enum {string} */
                  status: "APPROVED" | "REJECTED";
                  note: string;
                  /** Format: uuid */
                  reviewerId: string;
                  /** Format: date-time */
                  reviewedAt: string;
                };
                analysis?: unknown;
                evidence?: unknown[];
                /** @default [] */
                riskWarnings: string[];
                opportunityBreakdown?: unknown;
                riskBreakdown?: unknown;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/events/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 事件详情 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                eventType: string;
                sourceId: string;
                externalId: string;
                title: string;
                description: string;
                /** Format: uri */
                originalUrl: string | null;
                /** Format: date-time */
                sourcePublishedAt: string | null;
                /** Format: date-time */
                firstSeenAt: string;
                /** Format: date-time */
                collectedAt: string;
                /** Format: date-time */
                eventOccurredAt: string | null;
                /** Format: date-time */
                normalizedAt?: string;
                /** Format: date-time */
                detectedAt?: string;
                assets: string[];
                categories: string[];
                chain?: string;
                assetKey?: string;
                metrics?: {
                  [key: string]: number | string | unknown;
                };
                conditionsVerified?: boolean;
                rawDataReference: string;
                fingerprint: string;
                confidence: number;
                /** @enum {string} */
                severity: "P0" | "P1" | "P2" | "P3";
                /** @enum {string} */
                verificationStatus: "UNVERIFIED" | "VERIFIED" | "DISPUTED";
                /** @enum {string} */
                analysisStatus:
                  "PENDING" | "COMPLETED" | "FAILED" | "DISABLED" | "DEFERRED";
                opportunityScore: number;
                riskScore: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                updatedAt: string;
                review?: {
                  /** @enum {string} */
                  status: "APPROVED" | "REJECTED";
                  note: string;
                  /** Format: uuid */
                  reviewerId: string;
                  /** Format: date-time */
                  reviewedAt: string;
                };
                analysis?: unknown;
                evidence?: unknown[];
                /** @default [] */
                riskWarnings: string[];
                opportunityBreakdown?: unknown;
                riskBreakdown?: unknown;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/events/{id}/sources": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 事件证据来源 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                id: string;
                sourceId: string;
                rawItemId: string;
                url: string | null;
                sourcePublishedAt: string | null;
                firstSeenAt: string | null;
                collectedAt: string | null;
                payload?: unknown;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/projects": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 早期机会项目 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                name: string;
                chain: string;
                protocol: string;
                assetKey: string;
                /** @enum {string} */
                stage:
                  | "DISCOVERED"
                  | "UNVERIFIED"
                  | "VERIFIED"
                  | "EARLY_STAGE"
                  | "ACTIVE"
                  | "COMPLETED"
                  | "TRADING"
                  | "INACTIVE";
                /** @enum {string} */
                verificationStatus: "UNVERIFIED" | "VERIFIED" | "DISPUTED";
                riskFlagged: boolean;
                watching: boolean;
                /** Format: date-time */
                firstSeenAt: string;
                opportunityScore: number;
                riskScore: number;
                participants: number | null;
                participantGrowthPct: number | null;
                mintProgress: number | null;
                conditions: string | null;
                /** @default false */
                conditionsVerified: boolean;
                sourceUrls: string[];
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                startsAt?: string | null;
                /** Format: date-time */
                endsAt?: string | null;
                opportunityBreakdown?: unknown;
                riskBreakdown?: unknown;
                /** @default [] */
                riskWarnings: string[];
                /** Format: date-time */
                updatedAt?: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/projects/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 项目详情 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                name: string;
                chain: string;
                protocol: string;
                assetKey: string;
                /** @enum {string} */
                stage:
                  | "DISCOVERED"
                  | "UNVERIFIED"
                  | "VERIFIED"
                  | "EARLY_STAGE"
                  | "ACTIVE"
                  | "COMPLETED"
                  | "TRADING"
                  | "INACTIVE";
                /** @enum {string} */
                verificationStatus: "UNVERIFIED" | "VERIFIED" | "DISPUTED";
                riskFlagged: boolean;
                watching: boolean;
                /** Format: date-time */
                firstSeenAt: string;
                opportunityScore: number;
                riskScore: number;
                participants: number | null;
                participantGrowthPct: number | null;
                mintProgress: number | null;
                conditions: string | null;
                /** @default false */
                conditionsVerified: boolean;
                sourceUrls: string[];
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                startsAt?: string | null;
                /** Format: date-time */
                endsAt?: string | null;
                opportunityBreakdown?: unknown;
                riskBreakdown?: unknown;
                /** @default [] */
                riskWarnings: string[];
                /** Format: date-time */
                updatedAt?: string;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/projects/{id}/timeline": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 项目生命周期历史 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                id: string;
                fromStage: string | null;
                toStage: string;
                reason: string;
                evidenceIds: string[];
                occurredAt: string;
                recordedAt: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/projects/{id}/signals": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 项目独立信号 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                projectId: string | null;
                /** Format: uuid */
                eventId: string | null;
                type: string;
                /** Format: date-time */
                detectedAt: string;
                opportunityScore: number;
                riskScore: number;
                evidenceIds: string[];
                reason: string;
                scoringVersion: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/sources": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 数据源健康 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                id: string;
                name: string;
                connectorType: string;
                /** @enum {string} */
                mode: "live" | "fixture";
                enabled: boolean;
                status: string;
                intervalSeconds: number;
                /** Format: date-time */
                lastSuccessAt: string | null;
                lastError: string | null;
                /** Format: date-time */
                nextPollAt: string | null;
                successRate: number | null;
                latencyMs: number | null;
                freshnessSeconds: number | null;
                /** @default  */
                description: string;
                /** @default null */
                docsUrl: string | null;
                /** @default false */
                keyConfigured: boolean;
                /** @default [] */
                capabilities: string[];
                /** @default 由来源决定 */
                delayLabel: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/sources/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 数据源详情 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                id: string;
                name: string;
                connectorType: string;
                /** @enum {string} */
                mode: "live" | "fixture";
                enabled: boolean;
                status: string;
                intervalSeconds: number;
                /** Format: date-time */
                lastSuccessAt: string | null;
                lastError: string | null;
                /** Format: date-time */
                nextPollAt: string | null;
                successRate: number | null;
                latencyMs: number | null;
                freshnessSeconds: number | null;
                /** @default  */
                description: string;
                /** @default null */
                docsUrl: string | null;
                /** @default false */
                keyConfigured: boolean;
                /** @default [] */
                capabilities: string[];
                /** @default 由来源决定 */
                delayLabel: string;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** 启用或调整数据源 */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            enabled?: boolean;
            intervalSeconds?: number;
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data?: unknown;
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    trace?: never;
  };
  "/api/v1/sources/{id}/health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 数据源健康历史 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                id: string;
                status: string;
                latencyMs: number | null;
                error: string | null;
                observedAt: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/markets/assets": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 最新可用行情（含来源和延迟） */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                asset: string;
                name: string;
                value: number | null;
                unit: string;
                changePct: number | null;
                sourceId: string;
                /** Format: date-time */
                observedAt: string | null;
                delaySeconds: number | null;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                frequency?: string;
                sourceDate?: string | null;
                precision?: number | null;
                publicationTimeKnown?: boolean;
                delayLabel?: string;
                sourceUrl?: string;
                rawDataReference?: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/markets/history": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 历史观测（不插值） */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                observedAt: string;
                value: number;
                sourceId: string;
                unit: string;
                delaySeconds: number | null;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                frequency?: string;
                sourceDate?: string | null;
                publicationTimeKnown?: boolean;
                delayLabel?: string;
                sourceUrl?: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/dashboard": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 监控总览 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                onlineSources: number;
                totalSources: number;
                collectedToday: number;
                eventsToday: number;
                projectsToday: number;
                highPriorityAlerts: number;
                notificationSuccessRate: number | null;
                recentEvents: {
                  /** Format: uuid */
                  id: string;
                  eventType: string;
                  sourceId: string;
                  externalId: string;
                  title: string;
                  description: string;
                  /** Format: uri */
                  originalUrl: string | null;
                  /** Format: date-time */
                  sourcePublishedAt: string | null;
                  /** Format: date-time */
                  firstSeenAt: string;
                  /** Format: date-time */
                  collectedAt: string;
                  /** Format: date-time */
                  eventOccurredAt: string | null;
                  /** Format: date-time */
                  normalizedAt?: string;
                  /** Format: date-time */
                  detectedAt?: string;
                  assets: string[];
                  categories: string[];
                  chain?: string;
                  assetKey?: string;
                  metrics?: {
                    [key: string]: number | string | unknown;
                  };
                  conditionsVerified?: boolean;
                  rawDataReference: string;
                  fingerprint: string;
                  confidence: number;
                  /** @enum {string} */
                  severity: "P0" | "P1" | "P2" | "P3";
                  /** @enum {string} */
                  verificationStatus: "UNVERIFIED" | "VERIFIED" | "DISPUTED";
                  /** @enum {string} */
                  analysisStatus:
                    | "PENDING"
                    | "COMPLETED"
                    | "FAILED"
                    | "DISABLED"
                    | "DEFERRED";
                  opportunityScore: number;
                  riskScore: number;
                  /** @enum {string} */
                  dataMode: "live" | "fixture";
                  /** Format: date-time */
                  createdAt: string;
                  /** Format: date-time */
                  updatedAt: string;
                  review?: {
                    /** @enum {string} */
                    status: "APPROVED" | "REJECTED";
                    note: string;
                    /** Format: uuid */
                    reviewerId: string;
                    /** Format: date-time */
                    reviewedAt: string;
                  };
                  analysis?: unknown;
                  evidence?: unknown[];
                  /** @default [] */
                  riskWarnings: string[];
                  opportunityBreakdown?: unknown;
                  riskBreakdown?: unknown;
                }[];
                recentProjects: {
                  /** Format: uuid */
                  id: string;
                  name: string;
                  chain: string;
                  protocol: string;
                  assetKey: string;
                  /** @enum {string} */
                  stage:
                    | "DISCOVERED"
                    | "UNVERIFIED"
                    | "VERIFIED"
                    | "EARLY_STAGE"
                    | "ACTIVE"
                    | "COMPLETED"
                    | "TRADING"
                    | "INACTIVE";
                  /** @enum {string} */
                  verificationStatus: "UNVERIFIED" | "VERIFIED" | "DISPUTED";
                  riskFlagged: boolean;
                  watching: boolean;
                  /** Format: date-time */
                  firstSeenAt: string;
                  opportunityScore: number;
                  riskScore: number;
                  participants: number | null;
                  participantGrowthPct: number | null;
                  mintProgress: number | null;
                  conditions: string | null;
                  /** @default false */
                  conditionsVerified: boolean;
                  sourceUrls: string[];
                  /** @enum {string} */
                  dataMode: "live" | "fixture";
                  /** Format: date-time */
                  startsAt?: string | null;
                  /** Format: date-time */
                  endsAt?: string | null;
                  opportunityBreakdown?: unknown;
                  riskBreakdown?: unknown;
                  /** @default [] */
                  riskWarnings: string[];
                  /** Format: date-time */
                  updatedAt?: string;
                }[];
                recentAlerts: unknown[];
                workerOnline: boolean;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
                latency: {
                  p50Ms: number | null;
                  p95Ms: number | null;
                  samples: number;
                };
                trend: {
                  time: string;
                  events: number;
                  signals: number;
                }[];
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/system/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 系统版本与依赖状态 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                version: string;
                commitSha: string;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                asOf: string;
                worker: {
                  online: boolean;
                  lastHeartbeat: string | null;
                };
                queues: {
                  [key: string]: number | null;
                };
                ai: {
                  configured: boolean;
                  provider: string;
                  model: string;
                  dailyBudgetUsd: number;
                  usage: {
                    calls: number;
                    inputTokens: number;
                    outputTokens: number;
                    estimatedCost: number;
                  };
                };
                keys: {
                  [key: string]: boolean;
                };
                latency: {
                  p50Ms: number | null;
                  p95Ms: number | null;
                  samples: number;
                };
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/system/latency": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 各处理阶段真实延迟分位数 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                stage: string;
                p50Ms: number | null;
                p95Ms: number | null;
                samples: number;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/system/logs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 脱敏操作审计 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                id: string;
                action: string;
                entityType: string;
                entityId: string | null;
                createdAt: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/alert-rules": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 规则列表 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                name: string;
                /** @default true */
                enabled: boolean;
                conditions: {
                  eventTypes?: string[];
                  sourceIds?: string[];
                  assets?: string[];
                  categories?: string[];
                  chains?: string[];
                  stages?: (
                    | "DISCOVERED"
                    | "UNVERIFIED"
                    | "VERIFIED"
                    | "EARLY_STAGE"
                    | "ACTIVE"
                    | "COMPLETED"
                    | "TRADING"
                    | "INACTIVE"
                  )[];
                  minConfidence?: number;
                  minOpportunityScore?: number;
                  maxRiskScore?: number;
                  minParticipantGrowthPct?: number;
                  minMintProgress?: number;
                  maxMintProgress?: number;
                  minPriceChangePct?: number;
                  minYieldChangeBps?: number;
                  windowSeconds?: number;
                  maxAgeSeconds?: number;
                  verifiedOnly?: boolean;
                };
                /**
                 * @default P2
                 * @enum {string}
                 */
                priority: "P0" | "P1" | "P2" | "P3";
                /** @default 3600 */
                cooldownSeconds: number;
                /** @default [] */
                channelIds: string[];
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                ownerId: string;
                version: number;
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                updatedAt: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    /** 新建规则 */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            name: string;
            /** @default true */
            enabled?: boolean;
            conditions: {
              eventTypes?: string[];
              sourceIds?: string[];
              assets?: string[];
              categories?: string[];
              chains?: string[];
              stages?: (
                | "DISCOVERED"
                | "UNVERIFIED"
                | "VERIFIED"
                | "EARLY_STAGE"
                | "ACTIVE"
                | "COMPLETED"
                | "TRADING"
                | "INACTIVE"
              )[];
              minConfidence?: number;
              minOpportunityScore?: number;
              maxRiskScore?: number;
              minParticipantGrowthPct?: number;
              minMintProgress?: number;
              maxMintProgress?: number;
              minPriceChangePct?: number;
              minYieldChangeBps?: number;
              windowSeconds?: number;
              maxAgeSeconds?: number;
              verifiedOnly?: boolean;
            };
            /**
             * @default P2
             * @enum {string}
             */
            priority?: "P0" | "P1" | "P2" | "P3";
            /** @default 3600 */
            cooldownSeconds?: number;
            /** @default [] */
            channelIds?: string[];
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                name: string;
                /** @default true */
                enabled: boolean;
                conditions: {
                  eventTypes?: string[];
                  sourceIds?: string[];
                  assets?: string[];
                  categories?: string[];
                  chains?: string[];
                  stages?: (
                    | "DISCOVERED"
                    | "UNVERIFIED"
                    | "VERIFIED"
                    | "EARLY_STAGE"
                    | "ACTIVE"
                    | "COMPLETED"
                    | "TRADING"
                    | "INACTIVE"
                  )[];
                  minConfidence?: number;
                  minOpportunityScore?: number;
                  maxRiskScore?: number;
                  minParticipantGrowthPct?: number;
                  minMintProgress?: number;
                  maxMintProgress?: number;
                  minPriceChangePct?: number;
                  minYieldChangeBps?: number;
                  windowSeconds?: number;
                  maxAgeSeconds?: number;
                  verifiedOnly?: boolean;
                };
                /**
                 * @default P2
                 * @enum {string}
                 */
                priority: "P0" | "P1" | "P2" | "P3";
                /** @default 3600 */
                cooldownSeconds: number;
                /** @default [] */
                channelIds: string[];
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                ownerId: string;
                version: number;
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                updatedAt: string;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/alert-rules/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** 删除规则（保留触发审计） */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                ok: boolean;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    options?: never;
    head?: never;
    /** 更新规则并保留版本 */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            name?: string;
            /** @default true */
            enabled?: boolean;
            conditions?: {
              eventTypes?: string[];
              sourceIds?: string[];
              assets?: string[];
              categories?: string[];
              chains?: string[];
              stages?: (
                | "DISCOVERED"
                | "UNVERIFIED"
                | "VERIFIED"
                | "EARLY_STAGE"
                | "ACTIVE"
                | "COMPLETED"
                | "TRADING"
                | "INACTIVE"
              )[];
              minConfidence?: number;
              minOpportunityScore?: number;
              maxRiskScore?: number;
              minParticipantGrowthPct?: number;
              minMintProgress?: number;
              maxMintProgress?: number;
              minPriceChangePct?: number;
              minYieldChangeBps?: number;
              windowSeconds?: number;
              maxAgeSeconds?: number;
              verifiedOnly?: boolean;
            };
            /**
             * @default P2
             * @enum {string}
             */
            priority?: "P0" | "P1" | "P2" | "P3";
            /** @default 3600 */
            cooldownSeconds?: number;
            /** @default [] */
            channelIds?: string[];
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                name: string;
                /** @default true */
                enabled: boolean;
                conditions: {
                  eventTypes?: string[];
                  sourceIds?: string[];
                  assets?: string[];
                  categories?: string[];
                  chains?: string[];
                  stages?: (
                    | "DISCOVERED"
                    | "UNVERIFIED"
                    | "VERIFIED"
                    | "EARLY_STAGE"
                    | "ACTIVE"
                    | "COMPLETED"
                    | "TRADING"
                    | "INACTIVE"
                  )[];
                  minConfidence?: number;
                  minOpportunityScore?: number;
                  maxRiskScore?: number;
                  minParticipantGrowthPct?: number;
                  minMintProgress?: number;
                  maxMintProgress?: number;
                  minPriceChangePct?: number;
                  minYieldChangeBps?: number;
                  windowSeconds?: number;
                  maxAgeSeconds?: number;
                  verifiedOnly?: boolean;
                };
                /**
                 * @default P2
                 * @enum {string}
                 */
                priority: "P0" | "P1" | "P2" | "P3";
                /** @default 3600 */
                cooldownSeconds: number;
                /** @default [] */
                channelIds: string[];
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                ownerId: string;
                version: number;
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                updatedAt: string;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    trace?: never;
  };
  "/api/v1/alert-rules/test": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 测试规则（不发通知） */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /** Format: uuid */
            ruleId?: string;
            /** Format: uuid */
            eventId?: string;
            conditions?: {
              eventTypes?: string[];
              sourceIds?: string[];
              assets?: string[];
              categories?: string[];
              chains?: string[];
              stages?: (
                | "DISCOVERED"
                | "UNVERIFIED"
                | "VERIFIED"
                | "EARLY_STAGE"
                | "ACTIVE"
                | "COMPLETED"
                | "TRADING"
                | "INACTIVE"
              )[];
              minConfidence?: number;
              minOpportunityScore?: number;
              maxRiskScore?: number;
              minParticipantGrowthPct?: number;
              minMintProgress?: number;
              maxMintProgress?: number;
              minPriceChangePct?: number;
              minYieldChangeBps?: number;
              windowSeconds?: number;
              maxAgeSeconds?: number;
              verifiedOnly?: boolean;
            };
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                matched: boolean;
                reasons: string[];
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/alerts": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 规则触发记录 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                id: string;
                ruleId: string;
                ruleVersion: number;
                eventId: string | null;
                detectedAt: string;
                reason?: unknown;
                priority: string | null;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/notification-channels": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 通知渠道（仅配置状态） */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                name: string;
                /** @enum {string} */
                provider: "telegram" | "feishu" | "bark";
                enabled: boolean;
                configured: boolean;
                /** @default  */
                description: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/notification-channels/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** 启用或禁用通知渠道 */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            enabled: boolean;
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                enabled: boolean;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    trace?: never;
  };
  "/api/v1/notification-channels/test": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 发送手动测试通知 */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /** Format: uuid */
            channelId: string;
          };
        };
      };
      responses: {
        /** @description 成功 */
        202: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                status: "PENDING";
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/notifications": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 通知投递历史 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                channelId: string;
                /** Format: uuid */
                eventId: string | null;
                /** @enum {string} */
                status:
                  | "PENDING"
                  | "SENDING"
                  | "SENT"
                  | "FAILED"
                  | "RETRYING"
                  | "CANCELLED";
                attempts: number;
                /** Format: date-time */
                queuedAt: string;
                /** Format: date-time */
                acceptedAt: string | null;
                lastError: string | null;
                title: string;
                /** @default  */
                body: string;
                /**
                 * @default P2
                 * @enum {string}
                 */
                priority: "P0" | "P1" | "P2" | "P3";
                /** @enum {string} */
                dataMode: "live" | "fixture";
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/notifications/{id}/retry": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 重试失败通知 */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        202: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                /** @enum {string} */
                status: "PENDING";
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/settings": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 用户偏好 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /**
                 * @default dark
                 * @enum {string}
                 */
                theme: "dark" | "light" | "system";
                /** @default Asia/Shanghai */
                timezone: string;
                /** @default zh-CN */
                locale: string;
                /**
                 * @default {
                 *       "quietStart": null,
                 *       "quietEnd": null,
                 *       "minimumPriority": "P2"
                 *     }
                 */
                notifications: {
                  /** @default null */
                  quietStart: number | null;
                  /** @default null */
                  quietEnd: number | null;
                  /**
                   * @default P2
                   * @enum {string}
                   */
                  minimumPriority: "P0" | "P1" | "P2" | "P3";
                };
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** 保存用户偏好 */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /**
             * @default dark
             * @enum {string}
             */
            theme?: "dark" | "light" | "system";
            /** @default Asia/Shanghai */
            timezone?: string;
            /** @default zh-CN */
            locale?: string;
            /**
             * @default {
             *       "quietStart": null,
             *       "quietEnd": null,
             *       "minimumPriority": "P2"
             *     }
             */
            notifications?: {
              /** @default null */
              quietStart?: number | null;
              /** @default null */
              quietEnd?: number | null;
              /**
               * @default P2
               * @enum {string}
               */
              minimumPriority?: "P0" | "P1" | "P2" | "P3";
            };
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /**
                 * @default dark
                 * @enum {string}
                 */
                theme: "dark" | "light" | "system";
                /** @default Asia/Shanghai */
                timezone: string;
                /** @default zh-CN */
                locale: string;
                /**
                 * @default {
                 *       "quietStart": null,
                 *       "quietEnd": null,
                 *       "minimumPriority": "P2"
                 *     }
                 */
                notifications: {
                  /** @default null */
                  quietStart: number | null;
                  /** @default null */
                  quietEnd: number | null;
                  /**
                   * @default P2
                   * @enum {string}
                   */
                  minimumPriority: "P0" | "P1" | "P2" | "P3";
                };
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    trace?: never;
  };
  "/api/v1/watchlists": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 观察列表 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                name: string;
                createdAt: string;
                items: {
                  /** Format: uuid */
                  id: string;
                  assetKey: string;
                  createdAt: string;
                }[];
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    /** 新建观察列表 */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            name: string;
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                name: string;
                createdAt: string;
                items: {
                  /** Format: uuid */
                  id: string;
                  assetKey: string;
                  createdAt: string;
                }[];
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/watchlists/{id}/items": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 添加观察资产 */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            assetKey: string;
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                ok: boolean;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/watchlists/{id}/items/{assetKey}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** 移除观察资产 */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
          assetKey: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                ok: boolean;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/replay": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 历史信号回放（非收益回测） */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /** Format: date-time */
            at: string;
            /** @default {} */
            conditions?: {
              eventTypes?: string[];
              sourceIds?: string[];
              assets?: string[];
              categories?: string[];
              chains?: string[];
              stages?: (
                | "DISCOVERED"
                | "UNVERIFIED"
                | "VERIFIED"
                | "EARLY_STAGE"
                | "ACTIVE"
                | "COMPLETED"
                | "TRADING"
                | "INACTIVE"
              )[];
              minConfidence?: number;
              minOpportunityScore?: number;
              maxRiskScore?: number;
              minParticipantGrowthPct?: number;
              minMintProgress?: number;
              maxMintProgress?: number;
              minPriceChangePct?: number;
              minYieldChangeBps?: number;
              windowSeconds?: number;
              maxAgeSeconds?: number;
              verifiedOnly?: boolean;
            };
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data?: unknown;
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/calendar": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 经济日历（未知字段为空，非官方预期不填充） */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                sourceId: string;
                externalId: string;
                title: string;
                country: string;
                /** Format: date-time */
                scheduledAt: string;
                previousValue: string | null;
                expectedValue: string | null;
                actualValue: string | null;
                /** @enum {string} */
                importance: "high" | "medium" | "low";
                confirmed: boolean;
                /** Format: uri */
                sourceUrl: string;
                /** Format: date-time */
                sourcePublishedAt: string | null;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: uuid */
                id: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/calendar/import": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 管理员导入可靠来源日历（不自动推定发布） */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            items: {
              sourceId: string;
              externalId: string;
              title: string;
              country: string;
              /** Format: date-time */
              scheduledAt: string;
              previousValue: string | null;
              expectedValue: string | null;
              actualValue: string | null;
              /** @enum {string} */
              importance: "high" | "medium" | "low";
              confirmed: boolean;
              /** Format: uri */
              sourceUrl: string;
              /** Format: date-time */
              sourcePublishedAt: string | null;
              /** @enum {string} */
              dataMode: "live" | "fixture";
            }[];
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                imported: number;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/system/scoring": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 当前机会与风险评分权重和版本 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                opportunity: {
                  version: string;
                  weights: {
                    sourceTrust: number;
                    stage: number;
                    freshness: number;
                    participantGrowth: number;
                    conditionTransparency: number;
                    independentConfirmation: number;
                    communityGrowth: number;
                  };
                };
                risk: {
                  version: string;
                  weights: {
                    unverifiedOfficial: number;
                    permissions: number;
                    liquidity: number;
                    concentration: number;
                    suspiciousActivity: number;
                    contractSafety: number;
                    phishing: number;
                    cost: number;
                    mutableRules: number;
                  };
                };
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** 更新评分版本（保留历史，不重算已有信号） */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                opportunity: {
                  version: string;
                  weights: {
                    sourceTrust: number;
                    stage: number;
                    freshness: number;
                    participantGrowth: number;
                    conditionTransparency: number;
                    independentConfirmation: number;
                    communityGrowth: number;
                  };
                };
                risk: {
                  version: string;
                  weights: {
                    unverifiedOfficial: number;
                    permissions: number;
                    liquidity: number;
                    concentration: number;
                    suspiciousActivity: number;
                    contractSafety: number;
                    phishing: number;
                    cost: number;
                    mutableRules: number;
                  };
                };
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    trace?: never;
  };
  "/api/v1/system/scoring/history": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 已使用的评分版本快照 */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                key: string;
                data?: unknown;
                updatedAt: string;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/events/{id}/review": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** 人工复核AI分析（不改变来源或项目验证状态） */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /** @enum {string} */
            status: "APPROVED" | "REJECTED";
            /** @default  */
            note?: string;
          };
        };
      };
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                /** Format: uuid */
                id: string;
                eventType: string;
                sourceId: string;
                externalId: string;
                title: string;
                description: string;
                /** Format: uri */
                originalUrl: string | null;
                /** Format: date-time */
                sourcePublishedAt: string | null;
                /** Format: date-time */
                firstSeenAt: string;
                /** Format: date-time */
                collectedAt: string;
                /** Format: date-time */
                eventOccurredAt: string | null;
                /** Format: date-time */
                normalizedAt?: string;
                /** Format: date-time */
                detectedAt?: string;
                assets: string[];
                categories: string[];
                chain?: string;
                assetKey?: string;
                metrics?: {
                  [key: string]: number | string | unknown;
                };
                conditionsVerified?: boolean;
                rawDataReference: string;
                fingerprint: string;
                confidence: number;
                /** @enum {string} */
                severity: "P0" | "P1" | "P2" | "P3";
                /** @enum {string} */
                verificationStatus: "UNVERIFIED" | "VERIFIED" | "DISPUTED";
                /** @enum {string} */
                analysisStatus:
                  "PENDING" | "COMPLETED" | "FAILED" | "DISABLED" | "DEFERRED";
                opportunityScore: number;
                riskScore: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                updatedAt: string;
                review?: {
                  /** @enum {string} */
                  status: "APPROVED" | "REJECTED";
                  note: string;
                  /** Format: uuid */
                  reviewerId: string;
                  /** Format: date-time */
                  reviewedAt: string;
                };
                analysis?: unknown;
                evidence?: unknown[];
                /** @default [] */
                riskWarnings: string[];
                opportunityBreakdown?: unknown;
                riskBreakdown?: unknown;
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/projects/{id}/metrics": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 项目历史指标（每条保留来源和观测时间） */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                id: string;
                sourceId: string;
                observedAt: string;
                data?: unknown;
              }[];
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api/v1/digests/daily": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** 每日金融摘要（只汇总持久化事实与已完成分析） */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description 成功 */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              data: {
                day: string;
                /** @enum {string} */
                timezone: "UTC";
                /** @enum {string} */
                dataMode: "fixture" | "live";
                asOf: string;
                /** @enum {string} */
                method: "stored-evidence-and-analysis";
                totalEvents: number;
                categories: {
                  name: string;
                  count: number;
                }[];
                items: {
                  eventId: string;
                  title: string;
                  severity: string;
                  summary: string;
                  analysisStatus: string;
                  sourceUrls: string[];
                  firstSeenAt: string;
                  riskWarnings: string[];
                }[];
                limitations: string[];
              };
              meta?: {
                total: number;
                page: number;
                pageSize: number;
                /** @enum {string} */
                dataMode: "live" | "fixture";
                /** Format: date-time */
                asOf: string;
              };
            };
          };
        };
        /** @description 输入无效 */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 需要登录 */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 权限或 CSRF 校验失败 */
        403: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
        /** @description 请求频率超过限制 */
        429: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              error: {
                code: string;
                message: string;
                requestId: string;
              };
            };
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: never;
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
