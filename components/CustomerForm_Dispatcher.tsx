
import React, { useState } from 'react';
import { Customer, PaymentType } from '../types';

interface CustomerFormProps {
  initialData?: Customer;
  onSubmit: (data: Customer) => void;
  onCancel: () => void;
}

const CustomerFormDispatcher: React.FC<CustomerFormProps> = ({ initialData, onSubmit, onCancel }) => {
  const [formData, setFormData] = useState<Customer>(initialData || {
    id: Math.random().toString(36).substr(2, 9),
    name: '',
    phone: '',
    email: '',
    inn: '',
    paymentType: PaymentType.CASH,
    address: '',
    comment: ''
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  return (
    <div className="bg-white p-8 rounded-[2.5rem] shadow-2xl border border-slate-200">
      <div className="mb-8">
        <h2 className="text-2xl font-black text-slate-900 uppercase tracking-tighter">
          {initialData ? '👤 Редактировать клиента' : '👤 Новый заказчик'}
        </h2>
        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Карточка контрагента</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-1.5">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">Название организации / ФИО</label>
            <input
              required
              type="text"
              placeholder="ООО 'Альфа-Снег'"
              className="w-full rounded-xl border-slate-200 bg-slate-50 p-4 text-sm font-bold focus:ring-2 focus:ring-blue-500 transition-all outline-none"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">ИНН</label>
            <input
              required
              type="text"
              placeholder="7700000000"
              className="w-full rounded-xl border-slate-200 bg-slate-50 p-4 text-sm font-bold focus:ring-2 focus:ring-blue-500 transition-all outline-none"
              value={formData.inn}
              onChange={e => setFormData({ ...formData, inn: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">Телефон</label>
            <input
              required
              type="tel"
              placeholder="+7 (___) ___-__-__"
              className="w-full rounded-xl border-slate-200 bg-slate-50 p-4 text-sm font-bold focus:ring-2 focus:ring-blue-500 transition-all outline-none"
              value={formData.phone}
              onChange={e => setFormData({ ...formData, phone: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">E-mail</label>
            <input
              type="email"
              placeholder="info@client.ru"
              className="w-full rounded-xl border-slate-200 bg-slate-50 p-4 text-sm font-bold focus:ring-2 focus:ring-blue-500 transition-all outline-none"
              value={formData.email}
              onChange={e => setFormData({ ...formData, email: e.target.value })}
            />
          </div>
        </div>

        <div className="space-y-3">
          <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">Тип оплаты</label>
          <div className="flex gap-4">
            {Object.values(PaymentType).map(type => (
              <button
                key={type}
                type="button"
                onClick={() => setFormData({ ...formData, paymentType: type })}
                className={`flex-1 py-4 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all ${
                  formData.paymentType === type 
                  ? 'bg-blue-600 text-white border-blue-600 shadow-xl' 
                  : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">Юридический адрес / Примечание</label>
          <textarea
            className="w-full rounded-xl border-slate-200 bg-slate-50 p-4 text-sm font-bold focus:ring-2 focus:ring-blue-500 transition-all outline-none"
            rows={2}
            value={formData.comment}
            onChange={e => setFormData({ ...formData, comment: e.target.value })}
          />
        </div>

        <div className="flex justify-end space-x-3 pt-6 border-t border-slate-100">
          <button
            type="button"
            onClick={onCancel}
            className="px-8 py-3 rounded-xl text-[10px] font-black uppercase text-slate-400 hover:bg-slate-50 transition-colors"
          >
            Отмена
          </button>
          <button
            type="submit"
            className="px-10 py-3 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-xl hover:bg-black transition-all"
          >
            Сохранить клиента
          </button>
        </div>
      </form>
    </div>
  );
};

export default CustomerFormDispatcher;
