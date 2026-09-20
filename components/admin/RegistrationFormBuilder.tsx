'use client';

import { type RegistrationField, type RegistrationFieldType } from '@/lib/registration-forms';
import { Trash2, Plus, GripVertical } from '@/components/icons';

interface RegistrationFormBuilderProps {
  fields: RegistrationField[];
  onChange: (fields: RegistrationField[]) => void;
}

const FIELD_PRESETS: Array<{ type: RegistrationFieldType; label: string }> = [
  { type: 'text', label: 'Text' },
  { type: 'textarea', label: 'Long text' },
  { type: 'email', label: 'Email' },
  { type: 'phone', label: 'Phone' },
  { type: 'number', label: 'Number' },
  { type: 'select', label: 'Dropdown' },
  { type: 'checkbox', label: 'Confirmation' },
];

function defaultField(type: RegistrationFieldType): RegistrationField {
  const labels: Record<RegistrationFieldType, string> = {
    text: 'Short answer',
    textarea: 'Additional information',
    email: 'Contact email',
    phone: 'Contact phone',
    number: 'Number',
    select: 'Choose an option',
    checkbox: 'I agree to the event terms',
  };

  return {
    id: crypto.randomUUID(),
    type,
    label: labels[type],
    required: false,
    ...(type === 'select' ? { options: ['Option 1', 'Option 2'] } : {}),
  };
}

export default function RegistrationFormBuilder({ fields, onChange }: RegistrationFormBuilderProps) {
  const handleAddField = (type: RegistrationFieldType) => onChange([...fields, defaultField(type)]);

  const handleUpdateField = (id: string, updates: Partial<RegistrationField>) => {
    onChange(fields.map((field) => field.id === id ? { ...field, ...updates } : field));
  };

  const handleTypeChange = (id: string, type: RegistrationFieldType) => {
    const field = fields.find((item) => item.id === id);
    if (!field) return;
    handleUpdateField(id, {
      type,
      ...(type === 'select' ? { options: field.options?.length ? field.options : ['Option 1'] } : { options: undefined }),
    });
  };

  const moveField = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const handleOptionChange = (fieldId: string, optionIndex: number, value: string) => {
    const field = fields.find((item) => item.id === fieldId);
    if (!field?.options) return;
    const options = [...field.options];
    options[optionIndex] = value;
    handleUpdateField(fieldId, { options });
  };

  const handleAddOption = (fieldId: string) => {
    const field = fields.find((item) => item.id === fieldId);
    if (!field?.options || field.options.length >= 50) return;
    handleUpdateField(fieldId, { options: [...field.options, `Option ${field.options.length + 1}`] });
  };

  const handleDeleteOption = (fieldId: string, optionIndex: number) => {
    const field = fields.find((item) => item.id === fieldId);
    if (!field?.options || field.options.length <= 1) return;
    handleUpdateField(fieldId, { options: field.options.filter((_, index) => index !== optionIndex) });
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap gap-2">
          {FIELD_PRESETS.map(({ type, label }) => (
            <button
              key={type}
              type="button"
              onClick={() => handleAddField(type)}
              disabled={fields.length >= 25}
              className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-white flex items-center gap-2 transition-colors disabled:opacity-40"
            >
              <Plus className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-zinc-500 mt-2">Add up to 25 questions. Answers are stored with each attendee ticket.</p>
      </div>

      <div className="space-y-4">
        {fields.length === 0 ? (
          <div className="p-8 border-2 border-dashed border-zinc-800 rounded-xl text-center text-zinc-500">
            No fields added. Add a question to show it during registration.
          </div>
        ) : fields.map((field, index) => (
          <div key={field.id} className="bg-zinc-900 border border-zinc-800 p-4 rounded-xl">
            <div className="flex items-start gap-3">
              <div className="mt-2 text-zinc-600" aria-hidden="true"><GripVertical className="w-5 h-5" /></div>

              <div className="flex-1 space-y-4 min-w-0">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3">
                  <div>
                    <label className="text-xs text-zinc-500 font-medium mb-1 block">Question label</label>
                    <input
                      type="text"
                      maxLength={160}
                      value={field.label}
                      onChange={(event) => handleUpdateField(field.id, { label: event.target.value })}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-red-500 focus:outline-none"
                      placeholder="e.g. What is your T-shirt size?"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 font-medium mb-1 block">Type</label>
                    <select
                      value={field.type}
                      onChange={(event) => handleTypeChange(field.id, event.target.value as RegistrationFieldType)}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-red-500 focus:outline-none"
                    >
                      {FIELD_PRESETS.map((preset) => <option key={preset.type} value={preset.type}>{preset.label}</option>)}
                    </select>
                  </div>
                </div>

                {field.type !== 'checkbox' && field.type !== 'select' && (
                  <div>
                    <label className="text-xs text-zinc-500 font-medium mb-1 block">Placeholder (optional)</label>
                    <input
                      type="text"
                      maxLength={160}
                      value={field.placeholder || ''}
                      onChange={(event) => handleUpdateField(field.id, { placeholder: event.target.value })}
                      className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-red-500 focus:outline-none"
                      placeholder="Help attendees answer this question"
                    />
                  </div>
                )}

                <div>
                  <label className="text-xs text-zinc-500 font-medium mb-1 block">Helper text (optional)</label>
                  <input
                    type="text"
                    maxLength={500}
                    value={field.helpText || ''}
                    onChange={(event) => handleUpdateField(field.id, { helpText: event.target.value })}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:border-red-500 focus:outline-none"
                    placeholder="Shown below the question"
                  />
                </div>

                {field.type === 'select' && (
                  <div className="space-y-2 pl-4 border-l-2 border-zinc-800">
                    <label className="text-xs text-zinc-500 font-medium block">Options</label>
                    {(field.options || []).map((option, optionIndex) => (
                      <div key={`${field.id}-${optionIndex}`} className="flex gap-2">
                        <input
                          type="text"
                          maxLength={120}
                          value={option}
                          onChange={(event) => handleOptionChange(field.id, optionIndex, event.target.value)}
                          className="flex-1 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:border-red-500 focus:outline-none"
                        />
                        <button type="button" onClick={() => handleDeleteOption(field.id, optionIndex)} disabled={(field.options?.length || 0) <= 1} className="p-1.5 text-zinc-500 hover:text-red-400 disabled:opacity-30" aria-label="Delete option">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    <button type="button" onClick={() => handleAddOption(field.id)} disabled={(field.options?.length || 0) >= 50} className="text-xs text-red-500 hover:text-red-400 font-medium flex items-center gap-1 disabled:opacity-30">
                      <Plus className="w-3 h-3" /> Add option
                    </button>
                  </div>
                )}

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(event) => handleUpdateField(field.id, { required: event.target.checked })}
                    className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-red-500 focus:ring-red-500/50"
                  />
                  <span className="text-sm text-zinc-400">Required field</span>
                </label>
              </div>

              <div className="flex flex-col gap-1">
                <button type="button" onClick={() => moveField(index, -1)} disabled={index === 0} className="px-2 py-1 text-xs text-zinc-400 hover:text-white disabled:opacity-30" aria-label="Move field up">↑</button>
                <button type="button" onClick={() => moveField(index, 1)} disabled={index === fields.length - 1} className="px-2 py-1 text-xs text-zinc-400 hover:text-white disabled:opacity-30" aria-label="Move field down">↓</button>
                <button type="button" onClick={() => onChange(fields.filter((item) => item.id !== field.id))} className="p-2 text-zinc-500 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors" aria-label="Delete field">
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
