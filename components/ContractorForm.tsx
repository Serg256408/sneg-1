
import React, { useState } from 'react';
import { Contractor } from '../types';

interface ContractorFormProps {
  initialData?: Contractor;
  onSubmit: (data: Contractor) => void;
  onCancel: () => void;
}

const COMMON_EQUIPMENT = ["Погрузчик", "Самосвал 20м3", "Самосвал 15м3", "Трактор JCB", "Экскаватор"];

const ContractorForm: React.FC<ContractorFormProps> = ({ initialData, onSubmit, onCancel }) => {
  const [formData, setFormData] = useState<Contractor>(initialData || {
    id: Math.random().toString(36).substr(2, 9),
    name: '',
    equipment: [],
    comments: '',
    phone: ''
  });

  const [newEquipment, setNewEquipment] = useState('');

  const addEquipment = (item?: string) => {
    const value = (item || newEquipment).trim();
    if (value && !formData.equipment.includes(value)) {
      setFormData({ ...formData, equipment: [...formData.equipment, value] });
      setNewEquipment('');
    }
  };

  const removeEquipment = (item: string) => {
    setFormData({ ...formData, equipment: formData.equipment.filter(e => e !== item) });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <div className="bg-white p-6 rounded-2xl shadow-2xl border border-slate-200">
      <div className="mb-6">
        <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">
          {initialData ? '⚙️ Редактировать подрядчика' : '🚛 Новый подрядчик'}
        </h2>
        <p className="text-xs text-slate-400 font-bold uppercase tracking-widest mt-1">Данные в базу техники</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Организация / ИП</label>
            <input
              required
              type="text"
              placeholder="Название"
              className="w-full rounded-xl border-slate-200 bg-slate-50 p-2.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Контактный номер</label>
            <input
              type="text"
              placeholder="+7 (___) ___-__-__"
              className="w-full rounded-xl border-slate-200 bg-slate-50 p-2.5 text-sm font-bold focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
              value={formData.phone}
              onChange={e => setFormData({ ...formData, phone: e.target.value })}
            />
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Техника в парке</label>
          
          <div className="flex flex-wrap gap-2 mb-3">
            {COMMON_EQUIPMENT.map(item => (
              <button
                key={item}
                type="button"
                onClick={() => addEquipment(item)}
                className={`text-[10px] px-3 py-1.5 rounded-full font-bold transition-all border ${
                  formData.equipment.includes(item) 
                  ? 'bg-blue-600 text-white border-blue-600' 
                  : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                }`}
              >
                + {item}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              className="flex-1 rounded-xl border-slate-200 bg-slate-50 p-2 text-sm font-medium"
              value={newEquipment}
              onChange={e => setNewEquipment(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && (e.preventDefault(), addEquipment())}
              placeholder="Свой вариант (Enter для добавления)"
            />
            <button
              type="button"
              onClick={() => addEquipment()}
              className="px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-black"
            >
              ОК
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mt-3 min-h-[32px]">
            {formData.equipment.map(item => (
              <span key={item} className="inline-flex items-center px-3 py-1 rounded-lg text-[11px] font-black uppercase bg-blue-50 text-blue-700 border border-blue-100 group">
                {item.includes('Самосвал') ? '🚛' : item.includes('Погрузчик') || item.includes('Трактор') ? '🚜' : '⚙️'} {item}
                <button type="button" onClick={() => removeEquipment(item)} className="ml-2 text-blue-300 hover:text-red-500 transition-colors">
                  ×
                </button>
              </span>
            ))}
            {formData.equipment.length === 0 && <span className="text-[10px] text-slate-300 italic">Техника не выбрана</span>}
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Примечания (Цены, Ночные смены, Условия)</label>
          <textarea
            className="w-full rounded-xl border-slate-200 bg-slate-50 p-3 text-sm font-medium focus:ring-2 focus:ring-blue-500 transition-all"
            rows={3}
            value={formData.comments}
            onChange={e => setFormData({ ...formData, comments: e.target.value })}
            placeholder="Напр: Только безнал с НДС, работают в САО..."
          />
        </div>

        <div className="flex justify-end space-x-3 pt-6 border-t border-slate-100">
          <button
            type="button"
            onClick={onCancel}
            className="px-6 py-2.5 rounded-xl text-sm font-bold text-slate-400 hover:bg-slate-50 transition-colors"
          >
            Отмена
          </button>
          <button
            type="submit"
            className="px-8 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-black uppercase tracking-wider shadow-lg shadow-blue-200 hover:bg-blue-700 hover:shadow-xl transition-all"
          >
            Сохранить в базу
          </button>
        </div>
      </form>
    </div>
  );
};

export default ContractorForm;
