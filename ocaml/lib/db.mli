val init_pool : 
  ?host:string -> 
  ?port:int -> 
  ?user:string -> 
  ?password:string -> 
  ?database:string -> 
  unit -> 
  unit Lwt.t

val get_user_by_id : id:int -> Types.user option Lwt.t
val get_user_by_email : string -> Types.user option Lwt.t
val get_channel : id:int -> Types.channel option Lwt.t
val get_message : id:int -> Types.message option Lwt.t
val create_reaction : message_id:int -> user_id:int -> emoji:string -> int option Lwt.t
val delete_reaction : message_id:int -> user_id:int -> emoji:string -> unit Lwt.t
val create_message : content:string -> user_id:int -> channel_id:int -> thread_id:int option -> Types.message option Lwt.t
val create_user : email:string -> password_hash:string -> display_name:string option -> role:string -> Types.user option Lwt.t
val update_user : id:int -> ?display_name:string -> ?password_hash:string -> unit -> Types.user option Lwt.t
val get_all_channels : unit -> Types.channel list Lwt.t
val create_channel : name:string -> is_private:bool -> Types.channel option Lwt.t
val get_channel_messages : channel_id:int -> Types.message list Lwt.t
val search_messages : query:string -> user_id:int -> role:string -> Types.message list Lwt.t
val get_thread : id:int -> Types.thread option Lwt.t
val get_thread_info : thread_id:int -> Types.thread_info Lwt.t
val get_thread_messages : thread_id:int -> Types.message list Lwt.t
val get_channel_threads : channel_id:int -> Types.thread_info list Lwt.t
val get_file_by_storage_path : storage_path:string -> Types.file_attachment option Lwt.t
val create_file_attachment : 
  filename:string -> 
  mime_type:string -> 
  size:int -> 
  storage_path:string -> 
  is_image:bool -> 
  message_id:int option -> 
  Types.file_attachment option Lwt.t 