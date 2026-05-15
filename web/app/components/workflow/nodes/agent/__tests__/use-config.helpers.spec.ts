import { describe, expect, it } from 'vitest'
import { VarType } from '@/app/components/workflow/nodes/tool/types'
import { normalizeAnyParameterSelector, resolveAgentParameterInput } from '../use-config.helpers'

describe('use-config.helpers', () => {
  describe('normalizeAnyParameterSelector', () => {
    it('should normalize and trim a valid selector array', () => {
      expect(normalizeAnyParameterSelector([' node-id ', ' payload '])).toEqual(['node-id', 'payload'])
    })

    it('should return null for invalid selectors', () => {
      expect(normalizeAnyParameterSelector('invalid')).toBeNull()
      expect(normalizeAnyParameterSelector(['only-one'])).toBeNull()
      expect(normalizeAnyParameterSelector(['node', ''])).toBeNull()
      expect(normalizeAnyParameterSelector(['node', 1])).toBeNull()
    })
  })

  describe('resolveAgentParameterInput', () => {
    it('should keep non-any parameters as constant and preserve false/zero values', () => {
      expect(resolveAgentParameterInput({ isAnyParameter: false, value: 0 })).toEqual({
        type: VarType.constant,
        value: 0,
      })
      expect(resolveAgentParameterInput({ isAnyParameter: false, value: false })).toEqual({
        type: VarType.constant,
        value: false,
      })
    })

    it('should map valid any selectors to variable type', () => {
      expect(resolveAgentParameterInput({ isAnyParameter: true, value: ['node', 'context'] })).toEqual({
        type: VarType.variable,
        value: ['node', 'context'],
      })
    })

    it('should map empty/invalid any selectors to a safe empty constant value', () => {
      expect(resolveAgentParameterInput({ isAnyParameter: true, value: [] })).toEqual({
        type: VarType.constant,
        value: '',
      })
      expect(resolveAgentParameterInput({ isAnyParameter: true, value: '' })).toEqual({
        type: VarType.constant,
        value: '',
      })
    })
  })
})
