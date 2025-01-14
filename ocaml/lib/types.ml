type user = {
  id: int;
  email: string;
  display_name: string option;
  role: string;
  password_hash: string;
  presence_status: string;  (* 'online', 'idle', 'offline' *)
  last_active: string;     (* timestamp *)
} [@@deriving show, eq, yojson]

type channel = {
  id: int;
  name: string;
  is_private: bool;
  is_dm: bool;
  dm_participants: int list option;
  role: string option;    (* member role restriction *)
} [@@deriving show, eq, yojson]

type message = {
  id: int;
  content: string;
  user_id: int;
  channel_id: int;
  created_at: string;
  thread_id: int option;
} [@@deriving show, eq, yojson]

type registration = {
  email: string;
  password: string;
  display_name: string option;
} [@@deriving yojson] 