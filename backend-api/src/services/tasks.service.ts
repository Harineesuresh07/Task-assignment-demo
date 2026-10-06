import prisma from '../lib/prisma';
import { DeadlineType, TaskProgress } from '@prisma/client';

class ServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export { ServiceError };

// ── Deadline rules ──

function enforceDeadlineRules(
  deadlineType: DeadlineType,
  deadline: string | null | undefined,
  deadlineNote: string | null | undefined,
) {
  if (deadlineType === 'FIXED' && !deadline) {
    throw new ServiceError('deadline is required when deadlineType is FIXED', 400);
  }
  if ((deadlineType === 'TBD' || deadlineType === 'NONE') && deadline) {
    throw new ServiceError(`deadline must not be provided when deadlineType is ${deadlineType}`, 400);
  }
  if (deadlineNote && deadlineType !== 'TENTATIVE' && deadlineType !== 'TBD') {
    throw new ServiceError('deadlineNote is only allowed when deadlineType is TENTATIVE or TBD', 400);
  }
}

function computeIsOverdue(deadlineType: DeadlineType, deadline: Date | null): boolean {
  if (!deadline) return false;
  if (deadlineType !== 'FIXED') return false;
  return new Date() > deadline;
}

function computeStudentIsLate(
  completedAt: Date | null,
  deadlineType: DeadlineType,
  deadline: Date | null,
): boolean | null {
  if (!completedAt || !deadline || deadlineType !== 'FIXED') return null;
  return completedAt > deadline;
}

// ── Notification helper ──

async function notifyStudents(taskId: string, title: string, message: string) {
  const submissions = await prisma.taskSubmission.findMany({
    where: { taskId },
    select: { studentId: true },
  });
  if (submissions.length === 0) return;

  await prisma.notification.createMany({
    data: submissions.map((s) => ({
      userId: s.studentId,
      title,
      message,
      type: 'TASK_UPDATE' as const,
    })),
  });
}

// ── Batch auth helpers ──

async function checkTrainerBatchAuth(trainerId: string, batchIds: string[]) {
  const trainerBatches = await prisma.batchTrainer.findMany({
    where: { trainerId, batchId: { in: batchIds } },
    select: { batchId: true },
  });
  const authorizedIds = new Set(trainerBatches.map((tb) => tb.batchId));
  const unauthorized = batchIds.filter((id) => !authorizedIds.has(id));
  if (unauthorized.length > 0) {
    throw new ServiceError('Not authorized for one or more batches', 403);
  }
}

// ── Progress counts ──

function progressCounts(submissions: { progress: TaskProgress }[]) {
  const counts: Record<string, number> = {
    NOT_STARTED: 0, IN_PROGRESS: 0, ALMOST_COMPLETED: 0, COMPLETED: 0,
  };
  for (const s of submissions) {
    counts[s.progress]++;
  }
  return counts;
}

// ── Normalize deadline string to end-of-day IST (23:59:59.999 IST = 18:29:59.999 UTC) if date-only ──

function normalizeDeadline(deadline: string | null | undefined): Date | null {
  if (!deadline) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return new Date(`${deadline}T18:29:59.999Z`);
  }
  return new Date(deadline);
}

// ── CRUD ──

interface CreateTaskInput {
  title: string;
  description?: string | null;
  batchIds: string[];
  isMandatory?: boolean;
  isInternal?: boolean;
  maxMarks?: number | null;
  deadlineType?: DeadlineType;
  deadline?: string | null;
  deadlineNote?: string | null;
}

export async function createTask(
  createdById: string,
  input: CreateTaskInput,
  scope: 'any' | 'batch',
) {
  const isMandatory = input.isMandatory ?? true;
  const isInternal = input.isInternal ?? false;
  const deadlineType = input.deadlineType ?? 'NONE';

  if (isInternal && (input.maxMarks === undefined || input.maxMarks === null)) {
    throw new ServiceError('maxMarks is required when isInternal is true', 400);
  }
  if (!isInternal && input.maxMarks) {
    throw new ServiceError('maxMarks must not be provided when isInternal is false', 400);
  }

  enforceDeadlineRules(deadlineType, input.deadline, input.deadlineNote);

  if (isMandatory && deadlineType === 'NONE') {
    throw new ServiceError('deadlineType NONE is not allowed for mandatory tasks', 400);
  }

  const batches = await prisma.batch.findMany({
    where: { id: { in: input.batchIds } },
    select: { id: true },
  });
  if (batches.length !== input.batchIds.length) {
    throw new ServiceError('One or more batch IDs not found', 404);
  }

  if (scope === 'batch') {
    await checkTrainerBatchAuth(createdById, input.batchIds);
  }

  const deadlineDate = normalizeDeadline(input.deadline);

  return prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        createdById,
        title: input.title,
        description: input.description ?? null,
        isMandatory,
        isInternal,
        maxMarks: isInternal ? input.maxMarks : null,
        deadlineType,
        deadline: deadlineDate,
        deadlineNote: input.deadlineNote ?? null,
        taskBatches: {
          create: input.batchIds.map((batchId) => ({ batchId })),
        },
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        taskBatches: { include: { batch: { select: { id: true, name: true } } } },
      },
    });

    if (isMandatory) {
      const members = await tx.batchMember.findMany({
        where: { batchId: { in: input.batchIds } },
        select: { studentId: true },
      });
      const uniqueStudentIds = [...new Set(members.map((m) => m.studentId))];

      if (uniqueStudentIds.length > 0) {
        await tx.taskSubmission.createMany({
          data: uniqueStudentIds.map((studentId) => ({
            taskId: task.id,
            studentId,
          })),
        });
      }
    }

    const submissionCount = await tx.taskSubmission.count({ where: { taskId: task.id } });

    return {
      ...task,
      isOverdue: computeIsOverdue(task.deadlineType, task.deadline),
      submissionCount,
    };
  });
}

export async function listTasks(
  filters: {
    batchId?: string;
    isMandatory?: boolean;
    isInternal?: boolean;
    deadlineType?: DeadlineType;
    status?: 'open' | 'closed';
    search?: string;
  },
  scope: 'any' | 'batch' | 'own',
  requesterId: string,
  page = 1,
  limit = 20,
) {
  const where: any = {};

  if (scope === 'batch') {
    const trainerBatches = await prisma.batchTrainer.findMany({
      where: { trainerId: requesterId },
      select: { batchId: true },
    });
    const trainerBatchIds = trainerBatches.map((tb) => tb.batchId);
    if (trainerBatchIds.length === 0) return { data: [], total: 0 };

    where.taskBatches = { some: { batchId: { in: trainerBatchIds } } };

    if (filters.batchId) {
      if (!trainerBatchIds.includes(filters.batchId)) {
        return { data: [], total: 0 };
      }
      where.taskBatches = { some: { batchId: filters.batchId } };
    }
  } else if (scope === 'own') {
    const memberships = await prisma.batchMember.findMany({
      where: { studentId: requesterId },
      select: { batchId: true },
    });
    const studentBatchIds = memberships.map((m) => m.batchId);
    if (studentBatchIds.length === 0) return { data: [], total: 0 };

    where.taskBatches = { some: { batchId: { in: studentBatchIds } } };
    where.closedAt = null;
  } else if (filters.batchId) {
    where.taskBatches = { some: { batchId: filters.batchId } };
  }

  if (filters.isMandatory !== undefined) where.isMandatory = filters.isMandatory;
  if (filters.isInternal !== undefined) where.isInternal = filters.isInternal;
  if (filters.deadlineType) where.deadlineType = filters.deadlineType;
  if (filters.status === 'open') where.closedAt = null;
  if (filters.status === 'closed') where.closedAt = { not: null };
  if (filters.search) where.title = { contains: filters.search, mode: 'insensitive' };

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        taskBatches: { include: { batch: { select: { id: true, name: true } } } },
        submissions: { select: { progress: true } },
        _count: { select: { submissions: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.task.count({ where }),
  ]);

  const data = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    isMandatory: task.isMandatory,
    isInternal: task.isInternal,
    maxMarks: task.maxMarks,
    deadlineType: task.deadlineType,
    deadline: task.deadline,
    deadlineNote: task.deadlineNote,
    closedAt: task.closedAt,
    isOverdue: computeIsOverdue(task.deadlineType, task.deadline),
    createdBy: task.createdBy,
    taskBatches: task.taskBatches,
    submissionCount: task._count.submissions,
    progressCounts: progressCounts(task.submissions),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }));

  return { data, total };
}

export async function getTaskById(
  id: string,
  scope: 'any' | 'batch' | 'own',
  requesterId: string,
  progressFilter?: TaskProgress,
) {
  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      taskBatches: { include: { batch: { select: { id: true, name: true } } } },
      submissions: {
        include: {
          student: { select: { id: true, name: true, email: true } },
          gradedBy: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!task) throw new ServiceError('Task not found', 404);

  if (scope === 'own') {
    const taskBatchIds = task.taskBatches.map((tb) => tb.batchId);
    const membership = await prisma.batchMember.findFirst({
      where: { studentId: requesterId, batchId: { in: taskBatchIds } },
    });
    if (!membership) throw new ServiceError('Task not found', 404);
  } else if (scope === 'batch') {
    const taskBatchIds = task.taskBatches.map((tb) => tb.batchId);
    const trainerBatch = await prisma.batchTrainer.findFirst({
      where: { trainerId: requesterId, batchId: { in: taskBatchIds } },
    });
    if (!trainerBatch) throw new ServiceError('Task not found', 404);
  }

  const allSubmissions = task.submissions;
  const filteredSubmissions = progressFilter
    ? allSubmissions.filter((s) => s.progress === progressFilter)
    : allSubmissions;

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    isMandatory: task.isMandatory,
    isInternal: task.isInternal,
    maxMarks: task.maxMarks,
    deadlineType: task.deadlineType,
    deadline: task.deadline,
    deadlineNote: task.deadlineNote,
    closedAt: task.closedAt,
    isOverdue: computeIsOverdue(task.deadlineType, task.deadline),
    createdBy: task.createdBy,
    taskBatches: task.taskBatches,
    submissions: filteredSubmissions,
    submissionCount: allSubmissions.length,
    progressCounts: progressCounts(allSubmissions),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  isMandatory?: boolean;
  isInternal?: boolean;
  maxMarks?: number | null;
  addBatchIds?: string[];
}

export async function updateTask(
  id: string,
  input: UpdateTaskInput,
  scope: 'any' | 'batch',
  requesterId: string,
) {
  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      taskBatches: { select: { batchId: true } },
      submissions: { select: { marksAwarded: true, progress: true } },
    },
  });

  if (!task) throw new ServiceError('Task not found', 404);
  if (task.closedAt) throw new ServiceError('Cannot edit a closed task — reopen it first', 409);

  if (scope === 'batch') {
    const taskBatchIds = task.taskBatches.map((tb) => tb.batchId);
    await checkTrainerBatchAuth(requesterId, taskBatchIds);
  }

  const resolvedIsInternal = input.isInternal ?? task.isInternal;
  const resolvedMaxMarks = input.maxMarks !== undefined ? input.maxMarks : task.maxMarks;

  if (resolvedIsInternal && !resolvedMaxMarks) {
    throw new ServiceError('maxMarks is required when isInternal is true', 400);
  }

  if (input.isMandatory === true && task.deadlineType === 'NONE') {
    throw new ServiceError('deadlineType NONE is not allowed for mandatory tasks', 400);
  }

  if (input.isInternal === false) {
    const hasMarks = task.submissions.some((s) => s.marksAwarded !== null);
    if (hasMarks) {
      throw new ServiceError('Cannot disable internal marks: students already have marks awarded', 409);
    }
  }

  if (input.maxMarks !== undefined && input.maxMarks !== null && task.isInternal) {
    const exceedsMax = task.submissions.some(
      (s) => s.marksAwarded !== null && s.marksAwarded > input.maxMarks!,
    );
    if (exceedsMax) {
      throw new ServiceError(`Cannot lower maxMarks: some students have marks above ${input.maxMarks}`, 409);
    }
  }

  return prisma.$transaction(async (tx) => {
    const updateData: Record<string, unknown> = {};
    if (input.title !== undefined) updateData.title = input.title;
    if (input.description !== undefined) updateData.description = input.description || null;
    if (input.isMandatory !== undefined) updateData.isMandatory = input.isMandatory;
    if (input.isInternal !== undefined) {
      updateData.isInternal = input.isInternal;
      if (!input.isInternal) updateData.maxMarks = null;
    }
    if (input.maxMarks !== undefined && resolvedIsInternal) updateData.maxMarks = input.maxMarks;

    const updated = await tx.task.update({
      where: { id },
      data: updateData,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        taskBatches: { include: { batch: { select: { id: true, name: true } } } },
        _count: { select: { submissions: true } },
      },
    });

    if (input.addBatchIds && input.addBatchIds.length > 0) {
      const existingBatchIds = new Set(task.taskBatches.map((tb) => tb.batchId));
      const newBatchIds = input.addBatchIds.filter((id) => !existingBatchIds.has(id));

      if (newBatchIds.length > 0) {
        const batches = await tx.batch.findMany({
          where: { id: { in: newBatchIds } },
          select: { id: true },
        });
        if (batches.length !== newBatchIds.length) {
          throw new ServiceError('One or more new batch IDs not found', 404);
        }

        if (scope === 'batch') {
          await checkTrainerBatchAuth(requesterId, newBatchIds);
        }

        await tx.taskBatch.createMany({
          data: newBatchIds.map((batchId) => ({ taskId: id, batchId })),
        });

        const resolvedMandatory = input.isMandatory ?? task.isMandatory;
        if (resolvedMandatory) {
          const members = await tx.batchMember.findMany({
            where: { batchId: { in: newBatchIds } },
            select: { studentId: true },
          });
          const existingSubs = await tx.taskSubmission.findMany({
            where: { taskId: id },
            select: { studentId: true },
          });
          const existingStudentIds = new Set(existingSubs.map((s) => s.studentId));
          const newStudents = [...new Set(members.map((m) => m.studentId))]
            .filter((sid) => !existingStudentIds.has(sid));

          if (newStudents.length > 0) {
            await tx.taskSubmission.createMany({
              data: newStudents.map((studentId) => ({ taskId: id, studentId })),
            });
          }
        }
      }
    }

    if (input.isMandatory === true && !task.isMandatory) {
      const allBatchIds = (await tx.taskBatch.findMany({
        where: { taskId: id },
        select: { batchId: true },
      })).map((tb) => tb.batchId);

      const members = await tx.batchMember.findMany({
        where: { batchId: { in: allBatchIds } },
        select: { studentId: true },
      });
      const existingSubs = await tx.taskSubmission.findMany({
        where: { taskId: id },
        select: { studentId: true },
      });
      const existingStudentIds = new Set(existingSubs.map((s) => s.studentId));
      const newStudents = [...new Set(members.map((m) => m.studentId))]
        .filter((sid) => !existingStudentIds.has(sid));

      if (newStudents.length > 0) {
        await tx.taskSubmission.createMany({
          data: newStudents.map((studentId) => ({ taskId: id, studentId })),
        });
      }
    }

    await notifyStudents(id, 'Task updated', `Task "${updated.title}" has been updated.`);

    return {
      ...updated,
      isOverdue: computeIsOverdue(updated.deadlineType, updated.deadline),
    };
  });
}

// ── Deadline change ──

export async function changeDeadline(
  id: string,
  input: {
    deadlineType: DeadlineType;
    deadline?: string | null;
    deadlineNote?: string | null;
  },
  scope: 'any' | 'batch',
  requesterId: string,
) {
  const task = await prisma.task.findUnique({
    where: { id },
    include: { taskBatches: { select: { batchId: true } } },
  });

  if (!task) throw new ServiceError('Task not found', 404);
  if (task.closedAt) throw new ServiceError('Cannot change deadline on a closed task', 409);

  if (scope === 'batch') {
    await checkTrainerBatchAuth(requesterId, task.taskBatches.map((tb) => tb.batchId));
  }

  enforceDeadlineRules(input.deadlineType, input.deadline, input.deadlineNote);

  if (task.isMandatory && input.deadlineType === 'NONE') {
    throw new ServiceError('deadlineType NONE is not allowed for mandatory tasks', 400);
  }

  const deadlineDate = normalizeDeadline(input.deadline);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id },
      data: {
        deadlineType: input.deadlineType,
        deadline: deadlineDate,
        deadlineNote: input.deadlineNote ?? null,
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        taskBatches: { include: { batch: { select: { id: true, name: true } } } },
        _count: { select: { submissions: true } },
      },
    });

    if (input.deadlineType === 'FIXED' && deadlineDate) {
      const completedSubs = await tx.taskSubmission.findMany({
        where: { taskId: id, progress: 'COMPLETED', completedAt: { not: null } },
        select: { id: true, completedAt: true },
      });
      for (const sub of completedSubs) {
        await tx.taskSubmission.update({
          where: { id: sub.id },
          data: { isLate: sub.completedAt! > deadlineDate },
        });
      }
    } else {
      await tx.taskSubmission.updateMany({
        where: { taskId: id },
        data: { isLate: null },
      });
    }

    await notifyStudents(id, 'Deadline changed', `Task "${updated.title}" deadline has been updated.`);

    return {
      ...updated,
      isOverdue: computeIsOverdue(updated.deadlineType, updated.deadline),
    };
  });
}

// ── Close / Reopen / Delete ──

export async function closeTask(
  id: string,
  scope: 'any' | 'batch',
  requesterId: string,
) {
  const task = await prisma.task.findUnique({
    where: { id },
    include: { taskBatches: { select: { batchId: true } } },
  });
  if (!task) throw new ServiceError('Task not found', 404);
  if (task.closedAt) throw new ServiceError('Task is already closed', 409);

  if (scope === 'batch') {
    await checkTrainerBatchAuth(requesterId, task.taskBatches.map((tb) => tb.batchId));
  }

  const updated = await prisma.task.update({
    where: { id },
    data: { closedAt: new Date() },
  });

  await notifyStudents(id, 'Task closed', `Task "${task.title}" has been closed.`);
  return updated;
}

export async function reopenTask(
  id: string,
  scope: 'any' | 'batch',
  requesterId: string,
) {
  const task = await prisma.task.findUnique({
    where: { id },
    include: { taskBatches: { select: { batchId: true } } },
  });
  if (!task) throw new ServiceError('Task not found', 404);
  if (!task.closedAt) throw new ServiceError('Task is not closed', 409);

  if (scope === 'batch') {
    await checkTrainerBatchAuth(requesterId, task.taskBatches.map((tb) => tb.batchId));
  }

  const updated = await prisma.task.update({
    where: { id },
    data: { closedAt: null },
  });

  await notifyStudents(id, 'Task reopened', `Task "${task.title}" has been reopened.`);
  return updated;
}

export async function deleteTask(
  id: string,
  scope: 'any' | 'batch',
  requesterId: string,
) {
  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      taskBatches: { select: { batchId: true } },
      submissions: { select: { progress: true } },
    },
  });
  if (!task) throw new ServiceError('Task not found', 404);

  if (scope === 'batch') {
    await checkTrainerBatchAuth(requesterId, task.taskBatches.map((tb) => tb.batchId));
  }

  const hasProgress = task.submissions.some((s) => s.progress !== 'NOT_STARTED');
  if (hasProgress) {
    throw new ServiceError(
      'Cannot delete task: students have started work — close it instead',
      409,
    );
  }

  await prisma.task.delete({ where: { id } });
}

// ── Student progress ──

export async function updateStudentProgress(
  taskId: string,
  studentId: string,
  progress: TaskProgress,
) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { taskBatches: { select: { batchId: true } } },
  });

  if (!task) throw new ServiceError('Task not found', 404);
  if (task.closedAt) throw new ServiceError('Cannot update progress on a closed task', 409);

  const taskBatchIds = task.taskBatches.map((tb) => tb.batchId);
  const membership = await prisma.batchMember.findFirst({
    where: { studentId, batchId: { in: taskBatchIds } },
  });
  if (!membership) {
    throw new ServiceError('You are not a member of any batch this task targets', 403);
  }

  let submission = await prisma.taskSubmission.findUnique({
    where: { taskId_studentId: { taskId, studentId } },
  });

  const isNew = !submission;

  if (!submission) {
    submission = await prisma.taskSubmission.create({
      data: { taskId, studentId },
    });
  }

  const now = new Date();
  let completedAt = submission.completedAt;
  let isLate = submission.isLate;

  if (progress === 'COMPLETED' && (isNew || submission.progress !== 'COMPLETED')) {
    completedAt = now;
    isLate = task.deadlineType === 'FIXED' && task.deadline ? now > task.deadline : null;
  } else if (progress !== 'COMPLETED' && !isNew && submission.progress === 'COMPLETED') {
    completedAt = null;
    isLate = null;
  }

  const updated = await prisma.taskSubmission.update({
    where: { taskId_studentId: { taskId, studentId } },
    data: { progress, completedAt, isLate },
  });

  return updated;
}

// ── Interest toggle ──

export async function toggleInterested(taskId: string, studentId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { taskBatches: { select: { batchId: true } } },
  });

  if (!task) throw new ServiceError('Task not found', 404);
  if (task.closedAt) throw new ServiceError('Cannot express interest in a closed task', 409);
  if (task.isMandatory) throw new ServiceError('Cannot toggle interest on a mandatory task', 400);

  const taskBatchIds = task.taskBatches.map((tb) => tb.batchId);
  const membership = await prisma.batchMember.findFirst({
    where: { studentId, batchId: { in: taskBatchIds } },
  });
  if (!membership) {
    throw new ServiceError('You are not a member of any batch this task targets', 403);
  }

  let submission = await prisma.taskSubmission.findUnique({
    where: { taskId_studentId: { taskId, studentId } },
  });

  if (!submission) {
    submission = await prisma.taskSubmission.create({
      data: { taskId, studentId, isInterested: true },
    });
    return { interested: true };
  }

  const updated = await prisma.taskSubmission.update({
    where: { taskId_studentId: { taskId, studentId } },
    data: { isInterested: !submission.isInterested },
  });

  return { interested: updated.isInterested };
}

// ── Manual add student ──

export async function addStudentToTask(
  taskId: string,
  studentId: string,
  scope: 'any' | 'batch',
  requesterId: string,
) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { taskBatches: { select: { batchId: true } } },
  });
  if (!task) throw new ServiceError('Task not found', 404);

  if (scope === 'batch') {
    await checkTrainerBatchAuth(requesterId, task.taskBatches.map((tb) => tb.batchId));
  }

  const taskBatchIds = task.taskBatches.map((tb) => tb.batchId);
  const membership = await prisma.batchMember.findFirst({
    where: { studentId, batchId: { in: taskBatchIds } },
  });
  if (!membership) {
    throw new ServiceError('Student is not in any of the task\'s target batches', 400);
  }

  const existing = await prisma.taskSubmission.findUnique({
    where: { taskId_studentId: { taskId, studentId } },
  });
  if (existing) {
    throw new ServiceError('Student already has a submission for this task', 409);
  }

  const submission = await prisma.taskSubmission.create({
    data: { taskId, studentId },
    include: { student: { select: { id: true, name: true, email: true } } },
  });

  return submission;
}

// ── Marks ──

export async function setMarks(
  taskId: string,
  studentId: string,
  marksAwarded: number | null,
  graderId: string,
  scope: 'any' | 'batch',
) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { taskBatches: { select: { batchId: true } } },
  });
  if (!task) throw new ServiceError('Task not found', 404);
  if (!task.isInternal) throw new ServiceError('Task is not internal — marks not applicable', 400);

  if (scope === 'batch') {
    await checkTrainerBatchAuth(graderId, task.taskBatches.map((tb) => tb.batchId));
  }

  if (marksAwarded !== null && task.maxMarks !== null && marksAwarded > task.maxMarks) {
    throw new ServiceError(`marksAwarded (${marksAwarded}) exceeds maxMarks (${task.maxMarks})`, 400);
  }

  const submission = await prisma.taskSubmission.findUnique({
    where: { taskId_studentId: { taskId, studentId } },
  });
  if (!submission) throw new ServiceError('No submission found for this student', 404);

  const updated = await prisma.taskSubmission.update({
    where: { taskId_studentId: { taskId, studentId } },
    data: {
      marksAwarded,
      gradedById: marksAwarded !== null ? graderId : null,
    },
    include: {
      student: { select: { id: true, name: true, email: true } },
      gradedBy: { select: { id: true, name: true } },
    },
  });

  return updated;
}

// ── Student my-tasks ──

export async function getMyTasks(
  studentId: string,
  filters: {
    batchId?: string;
    progress?: TaskProgress;
    isMandatory?: boolean;
    status?: 'open' | 'closed';
  },
) {
  const memberships = await prisma.batchMember.findMany({
    where: { studentId },
    select: { batchId: true },
  });
  const myBatchIds = memberships.map((m) => m.batchId);
  if (myBatchIds.length === 0) return [];

  const where: any = {
    taskBatches: { some: { batchId: { in: myBatchIds } } },
  };

  if (filters.batchId) {
    if (!myBatchIds.includes(filters.batchId)) return [];
    where.taskBatches = { some: { batchId: filters.batchId } };
  }

  if (filters.isMandatory !== undefined) where.isMandatory = filters.isMandatory;
  if (filters.status === 'closed') {
    where.closedAt = { not: null };
  } else {
    where.closedAt = null;
  }

  const tasks = await prisma.task.findMany({
    where,
    include: {
      taskBatches: { include: { batch: { select: { id: true, name: true } } } },
      submissions: {
        where: { studentId },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return tasks
    .filter((t) => {
      if (!filters.progress) return true;
      const sub = t.submissions[0];
      const actualProgress = sub?.progress ?? 'NOT_STARTED';
      return actualProgress === filters.progress;
    })
    .map((task) => {
      const sub = task.submissions[0];
      return {
        id: task.id,
        title: task.title,
        description: task.description,
        isMandatory: task.isMandatory,
        isInternal: task.isInternal,
        maxMarks: task.isInternal ? task.maxMarks : undefined,
        deadlineType: task.deadlineType,
        deadline: task.deadline,
        deadlineNote: task.deadlineNote,
        isOverdue: computeIsOverdue(task.deadlineType, task.deadline),
        taskBatches: task.taskBatches,
        progress: sub?.progress ?? 'NOT_STARTED',
        isInterested: sub?.isInterested ?? false,
        completedAt: sub?.completedAt ?? null,
        isLate: sub?.isLate ?? null,
        marksAwarded: task.isInternal ? (sub?.marksAwarded ?? null) : undefined,
      };
    });
}

// ── Risk engine provider ──

export async function getTaskStats(studentId: string, batchId: string) {
  const tasks = await prisma.task.findMany({
    where: {
      isMandatory: true,
      closedAt: null,
      taskBatches: { some: { batchId } },
    },
    include: {
      submissions: {
        where: { studentId },
        select: { progress: true, isLate: true },
      },
    },
  });

  let missedCount = 0;
  let lateCount = 0;

  for (const task of tasks) {
    if (task.deadlineType !== 'FIXED' || !task.deadline || new Date() <= task.deadline) continue;

    const sub = task.submissions[0];
    if (!sub || sub.progress !== 'COMPLETED') {
      missedCount++;
    } else if (sub.isLate) {
      lateCount++;
    }
  }

  return { missedCount, lateCount, totalMandatory: tasks.length };
}
