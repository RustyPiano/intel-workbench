export type RuntimeErrorCode =
  | "INVALID_ARGS"
  | "PATH_NOT_ALLOWED"
  | "FILE_NOT_FOUND"
  | "EDIT_NO_MATCH"
  | "EDIT_AMBIGUOUS"
  | "TOOL_TIMEOUT"
  | "PROCESS_EXIT_NONZERO"
  | "RUN_ABORTED"
  | "MODEL_ERROR"
  | "SESSION_CORRUPTED"
  | "SKILL_NOT_FOUND"
  | "SKILL_INVALID"
  | "INTERNAL_ERROR";

export interface RuntimeErrorShape {
  code: RuntimeErrorCode;
  message: string;
  retriable?: boolean;
  details?: Record<string, unknown>;
}

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retriable?: boolean;
  readonly details?: Record<string, unknown>;

  constructor(shape: RuntimeErrorShape) {
    super(shape.message);
    this.name = "RuntimeError";
    this.code = shape.code;
    this.retriable = shape.retriable;
    this.details = shape.details;
  }

  toJSON(): RuntimeErrorShape {
    return {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      details: this.details,
    };
  }
}

export function isRuntimeError(value: unknown): value is RuntimeError {
  return value instanceof RuntimeError;
}

export function toRuntimeErrorShape(error: unknown, fallbackCode: RuntimeErrorCode = "INTERNAL_ERROR"): RuntimeErrorShape {
  if (isRuntimeError(error)) {
    return error.toJSON();
  }

  if (error instanceof Error) {
    return {
      code: fallbackCode,
      message: error.message,
    };
  }

  return {
    code: fallbackCode,
    message: "Unknown runtime error",
    details: { error },
  };
}
