import { nanoid } from 'nanoid'

export const newId = (size = 12): string => nanoid(size)