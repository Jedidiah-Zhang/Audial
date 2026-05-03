import { useEffect, useState } from "react";
import {
  listSavedAccounts,
  subscribeSavedAccounts,
  type SavedAccount,
} from "@/utils/savedAccounts";

export function useSavedAccounts(): SavedAccount[] {
  const [list, setList] = useState<SavedAccount[]>([]);

  useEffect(() => {
    let active = true;
    const reload = () => {
      listSavedAccounts().then((next) => {
        if (active) setList(next);
      });
    };
    reload();
    const unsub = subscribeSavedAccounts(reload);
    return () => {
      active = false;
      unsub();
    };
  }, []);

  return list;
}
