-- CreateEnum
CREATE TYPE "DeadlineType" AS ENUM ('FIXED', 'TENTATIVE', 'TBD', 'NONE');

-- CreateEnum
CREATE TYPE "TaskProgress" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'ALMOST_COMPLETED', 'COMPLETED');

-- AlterEnum (add TASK_UPDATE to NotificationType)
ALTER TYPE "NotificationType" ADD VALUE 'TASK_UPDATE';

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT true,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "maxMarks" DOUBLE PRECISION,
    "deadlineType" "DeadlineType" NOT NULL DEFAULT 'NONE',
    "deadline" TIMESTAMP(3),
    "deadlineNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_batches" (
    "taskId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,

    CONSTRAINT "task_batches_pkey" PRIMARY KEY ("taskId","batchId")
);

-- CreateTable
CREATE TABLE "task_submissions" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "progress" "TaskProgress" NOT NULL DEFAULT 'NOT_STARTED',
    "isInterested" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "isLate" BOOLEAN,
    "marksAwarded" DOUBLE PRECISION,
    "gradedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_submissions_taskId_studentId_key" ON "task_submissions"("taskId", "studentId");

-- AddForeignKey: tasks.createdById -> users.id
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: task_batches.taskId -> tasks.id
ALTER TABLE "task_batches" ADD CONSTRAINT "task_batches_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: task_batches.batchId -> batches.id
ALTER TABLE "task_batches" ADD CONSTRAINT "task_batches_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: task_submissions.taskId -> tasks.id
ALTER TABLE "task_submissions" ADD CONSTRAINT "task_submissions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: task_submissions.studentId -> users.id
ALTER TABLE "task_submissions" ADD CONSTRAINT "task_submissions_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: task_submissions.gradedById -> users.id
ALTER TABLE "task_submissions" ADD CONSTRAINT "task_submissions_gradedById_fkey" FOREIGN KEY ("gradedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
