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

type thread = {
  id: int;
  channel_id: int;
  parent_message_id: int;
  reply_count: int;
  last_reply_at: string;
} [@@deriving show, eq, yojson]

type thread_info = {
  id: int;
  channel_id: int;
  reply_count: int;
  last_reply_at: string;
  thread_starter_content: string;
  thread_starter_name: string;
  thread_starter_id: int;
} [@@deriving show, eq, yojson]

type registration = {
  email: string;
  password: string;
  display_name: string option;
} [@@deriving yojson]

type file_attachment = {
  id: int;
  filename: string;
  mime_type: string;
  size: int;
  storage_path: string;
  is_image: bool;
  message_id: int option;
} [@@deriving show, eq, yojson]

type upload_request = {
  filename: string;
  content_type: string;
  size: int;
} [@@deriving yojson]

type upload_response = {
  upload_url: string;
  storage_path: string;
} [@@deriving yojson]

type download_response = {
  download_url: string;
  filename: string;
  is_image: bool;
  mime_type: string;
  size: int;
} [@@deriving yojson]

let channels_to_yojson channels =
  `List (List.map channel_to_yojson channels)

let messages_to_yojson messages =
  `List (List.map message_to_yojson messages)

let threads_to_yojson threads =
  `List (List.map thread_info_to_yojson threads) 