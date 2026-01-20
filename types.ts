
export enum OrderStatus {
  DRAFT = 'Черновик',
  SENT = 'Заявка отправлена',
  WAITING_APPROVAL = 'На проверке менеджером',
  AWAITING_CUSTOMER = 'Ожидает подтверждения клиента',
  CONFIRMED_BY_CUSTOMER = 'Подтверждено клиентом',
  IN_PROGRESS = 'В работе',
  COMPLETED = 'Завершено',
  DOCUMENTS_READY = 'Закрывающие документы готовы',
  CANCELLED = 'Отменено'
}

export enum AssetType {
  TRUCK = 'Самосвал',
  LOADER = 'Погрузчик',
  MINI_LOADER = 'Мини-погрузчик'
}

export enum PaymentType {
  CASH = 'Наличные',
  VAT_20 = 'С НДС 20%'
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  inn: string;
  paymentType: PaymentType;
  address?: string;
  comment?: string;
}

export interface TripEvidence {
  id: string;
  timestamp: string;
  photo: string; // base64 data
  driverName: string; 
  confirmed?: boolean; // Status of manager approval
}

export interface Contractor {
  id: string;
  name: string;
  equipment: string[];
  comments: string;
  phone: string;
}

export interface AssetRequirement {
  type: AssetType;
  contractorId: string; // If empty, it's a "Birzha" slot
  contractorName: string;
  plannedUnits: number;
  customerPrice?: number;
  birzhaPrice?: number;
}

export interface DriverAssignment {
  driverName: string; 
  contractorId: string;
  assetType: AssetType;
  acceptedPrice?: number;
  tripsConfirmed?: boolean;
}

export interface OrderRestrictions {
  hasHeightLimit: boolean;
  hasNarrowEntrance: boolean;
  hasPermitRegime: boolean;
  isNightWorkProhibited: boolean;
  comment: string;
}

export interface CustomerContact {
  name: string;
  phone: string;
  email: string;
  inn?: string;
  companyName?: string;
}

export interface Order {
  id: string;
  customer: string; // Customer Name
  customerId?: string; // Linked Customer ID
  address: string;
  coordinates: [number, number];
  
  assetRequirements: AssetRequirement[];
  isBirzhaOpen: boolean; 
  applicants: DriverAssignment[];

  assignedDrivers: string[];
  driverDetails: DriverAssignment[];
  
  plannedTrips: number;
  actualTrips: number;
  
  scheduledTime: string;
  isPaid: boolean;
  status: OrderStatus;
  managerName: string;
  createdAt: string;
  
  restrictions?: OrderRestrictions;
  contactInfo?: CustomerContact;
  evidences: TripEvidence[];
  isFrozen?: boolean; // Locked after customer confirmation
}

export type ManagerName = string;

export const DEFAULT_MANAGERS: ManagerName[] = ['АЛЕКСАНДР', 'ДМИТРИЙ', 'ЕКАТЕРИНА', 'СЕРГЕЙ'];
