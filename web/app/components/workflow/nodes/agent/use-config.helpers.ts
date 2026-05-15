import { VarType } from '../tool/types'

export const normalizeAnyParameterSelector = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length < 2)
    return null
  if (!value.every(item => typeof item === 'string' && item.trim()))
    return null
  return value.map(item => item.trim())
}

export const resolveAgentParameterInput = ({
  isAnyParameter,
  value,
}: {
  isAnyParameter: boolean
  value: unknown
}) => {
  if (!isAnyParameter) {
    return {
      type: VarType.constant,
      value,
    }
  }

  const normalizedSelector = normalizeAnyParameterSelector(value)
  if (normalizedSelector) {
    return {
      type: VarType.variable,
      value: normalizedSelector,
    }
  }

  return {
    type: VarType.constant,
    value: '',
  }
}
