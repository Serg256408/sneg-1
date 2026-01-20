
import React, { useState, useMemo } from 'react';
import { Order, OrderStatus, AssetType } from '../types';

interface MapDashboardProps {
  orders: Order[];
  onSelectOrder: (order: Order) => void;
}

const MapDashboard: React.FC<MapDashboardProps> = ({ orders, onSelectOrder }) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Центрируем карту по Москве (примерные координаты)
  const mapCenter = { lat: 55.7512, lng: 37.6184 };
  const scale = 2000; // Множитель для перевода координат в пиксели

  const projectToMap = (lat: number, lng: number) => {
    return {
      x: (lng - mapCenter.lng) * scale + 500, // 500 - центр SVG
      y: (mapCenter.lat - lat) * scale + 400  // 400 - центр SVG
    };
  };

  const getStatusColor = (status: OrderStatus) => {
    switch (status) {
      case OrderStatus.IN_PROGRESS: return '#3b82f6'; // Blue
      case OrderStatus.COMPLETED: return '#22c55e'; // Green
      case OrderStatus.AWAITING_CUSTOMER:
      case OrderStatus.WAITING_APPROVAL: return '#f97316'; // Orange
      default: return '#64748b'; // Slate
    }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-[75vh] animate-in fade-in slide-in-from-bottom-4 duration-700">
      {/* Interactive Map Area */}
      <div className="flex-1 bg-[#0a0f1d] rounded-[2.5rem] border border-white/5 relative overflow-hidden shadow-2xl">
        {/* Radar/Grid Effect Layer */}
        <div className="absolute inset-0 opacity-10 pointer-events-none">
          <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle, #3b82f6 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] border border-blue-500/20 rounded-full animate-pulse"></div>
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] border border-blue-500/10 rounded-full"></div>
        </div>

        <svg viewBox="0 0 1000 800" className="w-full h-full">
          {/* Moscow Ring (approximate) */}
          <circle cx="500" cy="400" r="300" fill="none" stroke="white" strokeWidth="0.5" strokeOpacity="0.05" />
          
          {orders.map(order => {
            const { x, y } = projectToMap(order.coordinates[0], order.coordinates[1]);
            const color = getStatusColor(order.status);
            const isHovered = hoveredId === order.id;

            return (
              <g 
                key={order.id} 
                className="cursor-pointer transition-all duration-300"
                onMouseEnter={() => setHoveredId(order.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => onSelectOrder(order)}
              >
                {/* Glow Effect */}
                {isHovered && <circle cx={x} cy={y} r="25" fill={color} fillOpacity="0.1" className="animate-ping" />}
                
                {/* Pin Circle */}
                <circle cx={x} cy={y} r={isHovered ? "14" : "10"} fill={color} className="shadow-2xl" />
                
                {/* Icon inside pin */}
                <text x={x} y={y + 4} textAnchor="middle" fontSize={isHovered ? "12" : "8"} className="pointer-events-none">
                  {order.assetRequirements.some(r => r.type === AssetType.TRUCK) ? '🚛' : '🚜'}
                </text>

                {/* Name Label */}
                {(isHovered || order.status === OrderStatus.IN_PROGRESS) && (
                  <g transform={`translate(${x + 15}, ${y - 15})`}>
                    <rect x="0" y="0" width="140" height="40" rx="10" fill="#12192c" fillOpacity="0.9" stroke={color} strokeWidth="1" />
                    <text x="10" y="18" fill="white" fontSize="9" fontWeight="900" className="uppercase tracking-tighter">
                      {order.customer.length > 20 ? order.customer.substring(0, 18) + '...' : order.customer}
                    </text>
                    <text x="10" y="32" fill={color} fontSize="8" fontWeight="bold" className="uppercase opacity-80">
                      {order.assignedDrivers.length > 0 ? `👥 ${order.assignedDrivers.join(', ')}` : '🔍 ПОИСК...'}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {/* Legend */}
        <div className="absolute bottom-8 left-8 bg-[#12192c]/80 backdrop-blur-xl p-6 rounded-3xl border border-white/5 flex gap-6 shadow-2xl">
           <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-blue-500"></span>
              <span className="text-[9px] font-black uppercase text-slate-400">В РАБОТЕ</span>
           </div>
           <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-orange-500"></span>
              <span className="text-[9px] font-black uppercase text-slate-400">ОЖИДАНИЕ</span>
           </div>
           <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-green-500"></span>
              <span className="text-[9px] font-black uppercase text-slate-400">ГОТОВО</span>
           </div>
        </div>
      </div>

      {/* Brief Cards Sidebar */}
      <div className="w-full lg:w-96 flex flex-col gap-4 overflow-y-auto no-scrollbar pb-10">
        <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.3em] px-2 mb-2 flex items-center justify-between">
           Активные точки <span>({orders.length})</span>
        </h3>
        
        {orders.map(order => {
          const isHovered = hoveredId === order.id;
          const isDone = order.actualTrips >= order.plannedTrips && order.plannedTrips > 0;
          
          return (
            <div 
              key={order.id}
              onMouseEnter={() => setHoveredId(order.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => onSelectOrder(order)}
              className={`group relative bg-white p-6 rounded-[2rem] border transition-all cursor-pointer shadow-xl ${isHovered ? 'border-blue-500 ring-4 ring-blue-500/10 -translate-y-1' : 'border-slate-200 hover:border-slate-300'}`}
            >
              <div className="flex justify-between items-start mb-4">
                 <div className="flex flex-col">
                    <span className="text-[10px] font-black text-blue-600 uppercase mb-1">{order.customer}</span>
                    <span className="text-sm font-black text-slate-800 leading-tight group-hover:text-blue-600 transition-colors uppercase">{order.address}</span>
                 </div>
                 <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-xl shadow-lg ${isDone ? 'bg-green-100' : 'bg-slate-100'}`}>
                    {order.assetRequirements.some(r => r.type === AssetType.TRUCK) ? '🚛' : '🚜'}
                 </div>
              </div>

              <div className="space-y-3">
                 <div className="flex items-center gap-4">
                    <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden shadow-inner">
                       <div 
                         className={`h-full transition-all duration-1000 ${isDone ? 'bg-green-500' : 'bg-blue-600'}`} 
                         style={{ width: `${Math.min(100, (order.actualTrips / order.plannedTrips) * 100)}%` }}
                       ></div>
                    </div>
                    <span className="text-[10px] font-black text-slate-900">{order.actualTrips}/{order.plannedTrips}</span>
                 </div>

                 <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-50">
                    {order.assignedDrivers.length > 0 ? (
                      order.assignedDrivers.map(d => (
                        <span key={d} className="text-[8px] font-black bg-slate-900 text-white px-3 py-1 rounded-lg uppercase tracking-widest">{d}</span>
                      ))
                    ) : (
                      <span className="text-[8px] font-black text-orange-500 bg-orange-50 px-3 py-1 rounded-lg uppercase border border-orange-100">Ищем водителей...</span>
                    )}
                 </div>
              </div>

              {/* Status Badge Mini */}
              <div className={`absolute top-0 right-10 -translate-y-1/2 px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-widest text-white shadow-xl ${getStatusColor(order.status) === '#3b82f6' ? 'bg-blue-600' : getStatusColor(order.status) === '#22c55e' ? 'bg-green-600' : 'bg-orange-500'}`}>
                 {order.status}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MapDashboard;
