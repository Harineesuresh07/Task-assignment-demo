import { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendError, sendPaginated } from '../utils/response';
import { TaskProgress, DeadlineType } from '@prisma/client';
import {
  ServiceError,
  createTask,
  listTasks,
  getTaskById,
  updateTask,
  changeDeadline,
  closeTask,
  reopenTask,
  deleteTask,
  updateStudentProgress,
  toggleInterested,
  addStudentToTask,
  setMarks,
  getMyTasks,
} from '../services/tasks.service';

function handleServiceError(err: unknown, res: Response, next: NextFunction) {
  if (
    err instanceof ServiceError ||
    (err instanceof Error && typeof (err as any).statusCode === 'number')
  ) {
    return sendError(res, (err as any).message, (err as any).statusCode);
  }
  next(err);
}

function deriveScope(req: Request): 'any' | 'batch' | 'own' {
  const held: Set<string> = (req as any).heldPermissions || new Set();
  if ([...held].some((c) => c.includes(':any'))) return 'any';
  if ([...held].some((c) => c.includes(':batch'))) return 'batch';
  return 'own';
}

function deriveWriteScope(req: Request): 'any' | 'batch' {
  const held: Set<string> = (req as any).heldPermissions || new Set();
  if ([...held].some((c) => c.includes(':any'))) return 'any';
  return 'batch';
}

export async function createTaskHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveWriteScope(req);
    const result = await createTask(req.user!.sub, req.body, scope);
    return sendSuccess(res, result, 201);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function listTasksHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveScope(req);
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10)));

    const filters: any = {};
    if (req.query.batchId) filters.batchId = String(req.query.batchId);
    if (req.query.isMandatory !== undefined) filters.isMandatory = req.query.isMandatory === 'true';
    if (req.query.isInternal !== undefined) filters.isInternal = req.query.isInternal === 'true';
    if (req.query.deadlineType) filters.deadlineType = String(req.query.deadlineType) as DeadlineType;
    if (req.query.status) filters.status = String(req.query.status);
    if (req.query.search) filters.search = String(req.query.search);

    const { data, total } = await listTasks(filters, scope, req.user!.sub, page, limit);
    return sendPaginated(res, data, total, page, limit);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function getTaskHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveScope(req);
    const progressFilter = req.query.progress
      ? (String(req.query.progress) as TaskProgress)
      : undefined;
    const result = await getTaskById(String(req.params.id), scope, req.user!.sub, progressFilter);
    return sendSuccess(res, result);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function updateTaskHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveWriteScope(req);
    const result = await updateTask(String(req.params.id), req.body, scope, req.user!.sub);
    return sendSuccess(res, result);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function changeDeadlineHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveWriteScope(req);
    const result = await changeDeadline(String(req.params.id), req.body, scope, req.user!.sub);
    return sendSuccess(res, result);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function closeTaskHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveWriteScope(req);
    await closeTask(String(req.params.id), scope, req.user!.sub);
    return sendSuccess(res, { message: 'Task closed successfully' });
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function reopenTaskHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveWriteScope(req);
    await reopenTask(String(req.params.id), scope, req.user!.sub);
    return sendSuccess(res, { message: 'Task reopened successfully' });
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function deleteTaskHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveWriteScope(req);
    await deleteTask(String(req.params.id), scope, req.user!.sub);
    return sendSuccess(res, { message: 'Task deleted successfully' });
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function updateProgressHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await updateStudentProgress(
      String(req.params.id),
      req.user!.sub,
      req.body.progress,
    );
    return sendSuccess(res, result);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function toggleInterestedHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await toggleInterested(String(req.params.id), req.user!.sub);
    return sendSuccess(res, result);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function addStudentHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveWriteScope(req);
    const result = await addStudentToTask(
      String(req.params.id),
      req.body.studentId,
      scope,
      req.user!.sub,
    );
    return sendSuccess(res, result, 201);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function setMarksHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const scope = deriveWriteScope(req);
    const result = await setMarks(
      String(req.params.id),
      req.body.studentId,
      req.body.marksAwarded,
      req.user!.sub,
      scope,
    );
    return sendSuccess(res, result);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}

export async function myTasksHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const filters: any = {};
    if (req.query.batchId) filters.batchId = String(req.query.batchId);
    if (req.query.progress) filters.progress = String(req.query.progress) as TaskProgress;
    if (req.query.isMandatory !== undefined) filters.isMandatory = req.query.isMandatory === 'true';
    if (req.query.status) filters.status = String(req.query.status);

    const result = await getMyTasks(req.user!.sub, filters);
    return sendSuccess(res, result);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
}
