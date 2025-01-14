open Types

type registration = {
  email: string;
  password: string;
  display_name: string option;
} [@@deriving yojson]

type thread = {
  id: int;
  channel_id: int;
  parent_message_id: int;
  reply_count: int;
  last_reply_at: string;  (* timestamp *)
} [@@deriving yojson, show]

type channel = {
  id: int;
  name: string;
  is_private: bool;
  is_dm: bool;
  dm_participants: int list option;
  role: string option;    (* member role restriction *)
} [@@deriving yojson, show]

type reaction = {
  id: int;
  message_id: int;
  user_id: int;
  emoji: string;
} [@@deriving yojson, show]

type file_attachment = {
  id: int;
  message_id: int;
  filename: string;
  mime_type: string;
  size: int;
  storage_path: string;
  is_image: bool;
  created_at: string;     (* timestamp *)
} [@@deriving yojson, show]

type client_message =
  | NewMessage of {
      content: string;
      channel_id: int;
      thread_id: int option;
    }
  | CreateThread of {
      parent_message_id: int;
      content: string;
    }
  | TypingStart of {
      channel_id: int;
    }
  | TypingStop of {
      channel_id: int;
    }
  | AddReaction of {
      message_id: int;
      emoji: string;
    }
  | RemoveReaction of {
      message_id: int;
      emoji: string;
    }
[@@deriving yojson, show]

type server_message =
  | MessageCreated of message
  | ThreadCreated of message
  | UserTyping of {
      user: user;
      channel_id: int;
    }
  | UserStoppedTyping of {
      user: user;
      channel_id: int;
    }
  | ReactionAdded of {
      message_id: int;
      emoji: string;
      user_id: int;
    }
  | ReactionRemoved of {
      message_id: int;
      emoji: string;
      user_id: int;
    }
[@@deriving yojson, show]

type connection = {
  user: user;
  send: server_message -> unit Lwt.t;
} 