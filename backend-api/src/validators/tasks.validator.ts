import Joi from 'joi';

const DEADLINE_TYPES = ['FIXED', 'TENTATIVE', 'TBD', 'NONE'] as const;
const DEADLINE_REQUIRES_DATE: string[] = ['FIXED'];
const DEADLINE_FORBIDS_DATE: string[] = ['TBD', 'NONE'];
const DEADLINE_NOTE_TYPES: string[] = ['TENTATIVE', 'TBD'];
const PROGRESS_VALUES = ['NOT_STARTED', 'IN_PROGRESS', 'ALMOST_COMPLETED', 'COMPLETED'] as const;

function validateDeadlineFields(value: any, helpers: Joi.CustomHelpers) {
  const { deadlineType, deadline, deadlineNote } = value;

  if (DEADLINE_REQUIRES_DATE.includes(deadlineType) && !deadline) {
    return helpers.message({
      custom: `deadline is required when deadlineType is ${deadlineType}` as any,
    });
  }

  if (DEADLINE_FORBIDS_DATE.includes(deadlineType) && deadline) {
    return helpers.message({
      custom: `deadline must not be provided when deadlineType is ${deadlineType}` as any,
    });
  }

  if (deadlineNote && !DEADLINE_NOTE_TYPES.includes(deadlineType)) {
    return helpers.message({
      custom: `deadlineNote is only allowed when deadlineType is TENTATIVE or TBD` as any,
    });
  }

  return value;
}

function validateInternalMarks(value: any, helpers: Joi.CustomHelpers) {
  const { isInternal, maxMarks } = value;

  if (isInternal === true && (maxMarks === undefined || maxMarks === null)) {
    return helpers.message({
      custom: 'maxMarks is required when isInternal is true' as any,
    });
  }

  if (isInternal === false && maxMarks !== undefined && maxMarks !== null) {
    return helpers.message({
      custom: 'maxMarks must not be provided when isInternal is false' as any,
    });
  }

  return value;
}

export const createTaskSchema = Joi.object({
  title: Joi.string().min(1).required()
    .messages({ 'string.empty': 'Title is required' }),
  description: Joi.string().allow('', null).optional(),
  batchIds: Joi.array().items(Joi.string().uuid()).min(1).unique().required()
    .messages({
      'array.min': 'At least one batchId is required',
      'string.guid': 'Each batchId must be a valid UUID',
    }),
  isMandatory: Joi.boolean().optional().default(true),
  isInternal: Joi.boolean().optional().default(false),
  maxMarks: Joi.number().positive().allow(null).optional()
    .messages({ 'number.positive': 'maxMarks must be positive' }),
  deadlineType: Joi.string().valid(...DEADLINE_TYPES).optional().default('NONE')
    .messages({ 'any.only': `deadlineType must be one of: ${DEADLINE_TYPES.join(', ')}` }),
  deadline: Joi.string().isoDate().allow(null).optional()
    .messages({ 'string.isoDate': 'deadline must be a valid ISO date' }),
  deadlineNote: Joi.string().allow('', null).optional(),
}).custom((value, helpers) => {
  let result = validateDeadlineFields(value, helpers);
  if (result !== value) return result;
  result = validateInternalMarks(value, helpers);
  if (result !== value) return result;

  if (value.isMandatory && value.deadlineType === 'NONE') {
    return helpers.message({
      custom: 'deadlineType NONE is not allowed for mandatory tasks' as any,
    });
  }

  return result;
});

export const updateTaskSchema = Joi.object({
  title: Joi.string().min(1).optional()
    .messages({ 'string.empty': 'Title cannot be empty' }),
  description: Joi.string().allow('', null).optional(),
  isMandatory: Joi.boolean().optional(),
  isInternal: Joi.boolean().optional(),
  maxMarks: Joi.number().positive().allow(null).optional()
    .messages({ 'number.positive': 'maxMarks must be positive' }),
  addBatchIds: Joi.array().items(Joi.string().uuid()).unique().optional()
    .messages({ 'string.guid': 'Each batchId must be a valid UUID' }),
}).min(1).messages({ 'object.min': 'At least one field must be provided' });

export const changeDeadlineSchema = Joi.object({
  deadlineType: Joi.string().valid(...DEADLINE_TYPES).required()
    .messages({ 'any.only': `deadlineType must be one of: ${DEADLINE_TYPES.join(', ')}` }),
  deadline: Joi.string().isoDate().allow(null).optional()
    .messages({ 'string.isoDate': 'deadline must be a valid ISO date' }),
  deadlineNote: Joi.string().allow('', null).optional(),
}).custom(validateDeadlineFields);

export const updateProgressSchema = Joi.object({
  progress: Joi.string().valid(...PROGRESS_VALUES).required()
    .messages({ 'any.only': `progress must be one of: ${PROGRESS_VALUES.join(', ')}` }),
});

export const setMarksSchema = Joi.object({
  studentId: Joi.string().uuid().required()
    .messages({ 'string.guid': 'studentId must be a valid UUID' }),
  marksAwarded: Joi.number().min(0).allow(null).required()
    .messages({ 'number.min': 'marksAwarded cannot be negative' }),
});

export const addStudentSchema = Joi.object({
  studentId: Joi.string().uuid().required()
    .messages({ 'string.guid': 'studentId must be a valid UUID' }),
});
