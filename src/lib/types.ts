/** Shared row + payload types for the MJPremium MLM system. */

export type Position = 'L' | 'C' | 'R';
export type AccountType = 'MA' | 'CA';
export type LedgerType = 'cash' | 'gc' | 'hang';
export type LedgerStatus = 'active' | 'hang' | 'released';
export type PinStatus = 'unused' | 'used' | 'pending_payment';
export type OrderStatus = 'pending' | 'approved' | 'rejected';
export type ActivationStatus = 'pending' | 'active';
/** Dashboard node selector (matches the mlm_active_node cookie). */
export type ActiveNode = 'MA' | 'C_L' | 'C_C' | 'C_R';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  email: string;
  display_name: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  phone: string;
  bday: string;
  gender: string;
  civil: string;
  address: string;
  profile_picture: string;
  rank: string;
  achievement_rank: string;
  activation_status: ActivationStatus;
  is_admin: boolean;
  sponsor_id: number;
  member_id_number: string;
  member_id_expires: string | Date | null;
  monthly_lp: number;
  monthly_lp_period: string;
  lp: number;
  lifetime_dr_paid: string;
  wallet_balance: string;
  hang_balance: string;
  account_held: boolean;
  is_free_account: boolean;
  free_account_kind: string;
  free_display_rank: string;
  free_receive_pairing: boolean;
  free_count_for_upline_pairing: boolean;
  free_pay_direct_referral: boolean;
  rank_history: unknown;
  created_at: Date;
}

export interface AccountRow {
  id: number;
  user_id: number;
  sponsor_id: number;
  upline_id: number;
  position: Position;
  account_type: AccountType;
  pairing_count: number;
  left_points: number;
  center_points: number;
  right_points: number;
  depth: number;
  rank_snapshot: string | null;
  activated_at: Date | null;
  status: number;
  created_at: Date;
}

export interface PinRow {
  id: number;
  pin_code: string;
  package_type: string;
  is_product: number;
  purchaser_id: number;
  status: PinStatus;
  used_by: number | null;
  used_at: Date | null;
  activation_source: string | null;
  activated_by_user_id: number | null;
  created_at: Date;
}

export interface LedgerRow {
  id: number;
  user_id: number;
  amount: string;
  tax_deducted: string;
  fee_deducted: string;
  type: LedgerType;
  status: LedgerStatus;
  note: string;
  created_at: Date;
}

export interface OrderRow {
  id: number;
  user_id: number;
  order_details: string;
  proof_image: string;
  status: OrderStatus;
  created_at: Date;
}

export interface PackageRow {
  id: number;
  pkg_name: string;
  pkg_price: string;
  pkg_desc: string;
  pkg_variants: string;
  is_product: number;
  status: number;
}

export interface AuditRow {
  id: number;
  actor_user_id: number;
  actor_username: string;
  actor_role: string;
  category: string;
  action: string;
  target_user_id: number;
  target_username: string;
  details: string;
  ip_address: string;
  user_agent: string;
  created_at: Date;
}

/** Genealogy tree node handed to the renderer (port of get_mlm_node()). */
export interface TreeNode {
  id: number;
  user_id: number;
  raw_user: string;
  name: string;
  type: AccountType;
  db_pos: Position;
  rank: string;
  depth: number;
  total_nodes: number;
  points: { L: number; C: number; R: number };
  pairing_count: number;
  L: TreeNode | null;
  C: TreeNode | null;
  R: TreeNode | null;
}

/** Empty-slot descriptor produced while rendering the tree. */
export interface TreeSlotState {
  allowed: boolean;
  hint: 'REGISTER' | 'SPILLOVER' | 'LOCKED_3_9' | 'LOCKED_RIGHT';
  label: string;
}

export interface Placement {
  upline_id: number;
  position: Position;
}

export interface PlacementCheck {
  ok: boolean;
  error?: string;
}

export interface RebuildStats {
  dr: number;
  nodes: number;
  wallets: number;
  gc: number;
  pairs: number;
  tri: number;
  uni: number;
}

export interface ApiError extends Error {
  status?: number;
}
