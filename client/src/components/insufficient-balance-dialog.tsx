import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertCircle, CreditCard } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface InsufficientBalanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requiredAmount: number;
  currentBalance: number;
  onDeposit: () => void;
}

export function InsufficientBalanceDialog({
  open,
  onOpenChange,
  requiredAmount,
  currentBalance,
  onDeposit
}: InsufficientBalanceDialogProps) {
  const missing = requiredAmount - currentBalance;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-5 w-5" />
            Saldo Insuficiente
          </DialogTitle>
          <DialogDescription>
            Você não tem saldo suficiente para realizar esta aposta.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="text-muted-foreground">Valor da aposta:</div>
            <div className="text-right font-medium">{formatCurrency(requiredAmount, false)}</div>
            
            <div className="text-muted-foreground">Seu saldo atual:</div>
            <div className="text-right font-medium">{formatCurrency(currentBalance, false)}</div>
            
            <div className="text-muted-foreground">Faltam:</div>
            <div className="text-right font-medium text-destructive">{formatCurrency(missing, false)}</div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={onDeposit} className="gap-2">
            <CreditCard className="h-4 w-4" />
            Depositar Agora
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
