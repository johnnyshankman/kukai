import { Component, OnInit, Input, ViewChild, ElementRef, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { KeyPair } from '../../../interfaces';
import { WalletService } from '../../../services/wallet/wallet.service';
import { CoordinatorService } from '../../../services/coordinator/coordinator.service';
import { OperationService } from '../../../services/operation/operation.service';
import { ExportService } from '../../../services/export/export.service';
import { InputValidationService } from '../../../services/input-validation/input-validation.service';
import { LedgerService } from '../../../services/ledger/ledger.service';
import { LedgerWallet, Account, ImplicitAccount, OriginatedAccount, TorusWallet } from '../../../services/wallet/wallet';
import { MessageService } from '../../../services/message/message.service';
import { TezosDomainsService } from '../../../services/tezos-domains/tezos-domains.service';
import { ActivatedRoute, Router } from '@angular/router';
import { ModalComponent } from '../modal.component';
import { Subscription } from 'rxjs';
import { SubjectService } from '../../../services/subject/subject.service';
import Big from 'big.js';

@Component({
  selector: 'app-delegate',
  templateUrl: './delegate.component.html',
  styleUrls: ['../../../../scss/components/modal/modal.scss']
})
export class DelegateComponent extends ModalComponent implements OnInit, OnChanges {
  domainPendingLookup = false;
  activeView = 0;
  recommendedFee = 0.0004;
  revealFee = 0;
  pkhFee = 0.0004;
  ktFee = 0.0008;
  @ViewChild('toPkhInput') toPkhView: ElementRef;
  @Input() beaconMode = false;
  @Input() operationRequest: any;
  @Output() operationResponse = new EventEmitter();
  activeAccount: Account;
  implicitAccounts;
  toPkh: string;
  storedDelegate: string;
  delegate = null;
  fee: string;
  storedFee: string;
  password: string;
  pwdValid: string;
  formInvalid = '';
  sendResponse: any;
  ledgerError = '';
  delegates = [];
  address = '';
  syncSub: Subscription;
  advanced = false;

  name = 'delegate-confirm';

  constructor(
    private route: ActivatedRoute,
    public walletService: WalletService,
    private operationService: OperationService,
    private coordinatorService: CoordinatorService,
    private exportService: ExportService,
    private inputValidationService: InputValidationService,
    private ledgerService: LedgerService,
    private messageService: MessageService,
    private tezosDomains: TezosDomainsService,
    private subjectService: SubjectService,
    private router: Router
  ) {
    super();
  }

  ngOnInit() {
    if (this.walletService.wallet) {
      this.init();
      this.address = this.route.snapshot.paramMap.get('address');

      let address = this.route.snapshot.paramMap.get('address');
      if (this.walletService.addressExists(address)) {
        this.activeAccount = this.walletService.wallet.getAccount(address);
      }

      this.walletService.activeAccount.subscribe(activeAccount => {
        this.activeAccount = activeAccount;
      });
    }
  }
  ngOnChanges(changes: SimpleChanges): void {
    if (this.beaconMode) {
      if (this.operationRequest) {
        const opReq = this.operationRequest.operationDetails ? this.operationRequest.operationDetails : this.operationRequest;
        if (opReq[0]?.kind === 'delegation') {
          if (opReq[0].delegate) {
            if (this.beaconMode) {
              ModalComponent.currentModel.next({ name: '', data: null });
              this.clearForm();
              ModalComponent.currentModel.next({ name: 'delegate-confirm', data: { address: opReq[0].delegate } });
            }
          }
        }
      }
    }
  }
  init() {
    this.implicitAccounts = this.walletService.wallet.implicitAccounts;
  }

  open(data) {
    if (this.walletService.wallet) {
      this.clearForm(true);
      this.checkReveal();
      if (!this.fee) { this.fee = this.recommendedFee.toString(); }
      this.storedFee = this.fee;
      this.storedDelegate = this.toPkh;
      this.toPkh = data.address;
      this.delegate = data;
      if (this.beaconMode) {
        this.syncSub = this.subjectService.beaconResponse.subscribe((response) => {
          if (response) {
            this.operationResponse.emit('silent');
          }
        });
      }
      super.open();
    }
  }

  async inject() {
    const pwd = this.password;
    this.password = '';
    this.messageService.startSpinner('Signing operation...');
    let keys;
    try {
      keys = await this.walletService.getKeys(pwd, this.activeAccount.pkh);
    } catch {
      this.messageService.stopSpinner();
    }
    if (this.walletService.isLedgerWallet()) {
      this.broadCastLedgerTransaction();
      this.sendResponse = null;
    } else {
      if (keys) {
        this.pwdValid = '';
        this.messageService.startSpinner('Sending operation...');
        this.sendDelegation(keys);
      } else {
        this.messageService.stopSpinner();
        if (this.walletService.wallet instanceof TorusWallet) {
          this.pwdValid = `Authorization failed`;
        } else {
          this.pwdValid = 'Wrong password!';
        }
      }
    }
  }
  async ledgerSign() {
    const keys = await this.walletService.getKeys('');
    if (keys) {
      this.sendDelegation(keys);
    }
  }

  async sendDelegation(keys: KeyPair) {
    let fee = this.fee;
    if (!fee) {
      fee = '0';
    }
    this.operationService.delegate(this.activeAccount.address, this.getDelegate(), Number(fee), keys).subscribe(
      async (ans: any) => {
        this.sendResponse = ans;
        console.log(JSON.stringify(ans));
        if (ans.success === true) {
          if (ans.payload.opHash) {
            this.operationResponse.emit(ans.payload.opHash);
            const metadata = { delegate: this.getDelegate(), opHash: ans.payload.opHash };
            this.coordinatorService.boost(this.activeAccount.address, metadata);
          } else if (this.walletService.isLedgerWallet()) {
            await this.requestLedgerSignature();
          }
          this.closeModal();
          this.router.navigate([`/account/${this.activeAccount.address}`]);
        } else {
          console.log('Delegation error id ', ans.payload.msg);
          this.messageService.addError(ans.payload.msg, 0);
          this.operationResponse.emit('broadcast_error');
          this.closeModal();
        }
      },
      err => {
        console.log('Error Message ', JSON.stringify(err));
        this.ledgerError = 'Failed to create operation';
      }
    );
  }
  async requestLedgerSignature() {
    if (this.walletService.wallet instanceof LedgerWallet) {
      const op = this.sendResponse.payload.unsignedOperation;
      this.messageService.startSpinner('Waiting for Ledger signature');
      let signature;
      try {
        signature = await this.ledgerService.signOperation('03' + op, this.walletService.wallet.implicitAccounts[0].derivationPath);
      } finally {
        this.messageService.stopSpinner();
      }
      if (signature) {
        const signedOp = op + signature;
        this.sendResponse.payload.signedOperation = signedOp;
        this.ledgerError = '';
      } else {
        this.ledgerError = 'Failed to sign operation';
      }
    }
  }
  async broadCastLedgerTransaction() {
    this.messageService.startSpinner('Broadcasting operation');
    this.operationService.broadcast(this.sendResponse.payload.signedOperation).subscribe(
      ((ans: any) => {
        this.sendResponse = ans;
        if (ans.success && this.activeAccount.address) {
          const metadata = { delegate: this.getDelegate(), opHash: ans.payload.opHash };
          this.coordinatorService.boost(this.activeAccount.address, metadata);
        } else {
          this.messageService.addError(this.sendResponse.payload.msg, 0);
          this.operationResponse.emit('broadcast_error');
        }
        this.closeModal();
        console.log('ans: ' + JSON.stringify(ans));
      }),
      (error => {
        this.messageService.stopSpinner();
        this.messageService.addError(error, 0);
        this.operationResponse.emit('broadcast_error');
      })
    );
  }
  checkReveal() {
    console.log('check reveal ' + this.activeAccount.pkh);
    this.operationService.isRevealed(this.activeAccount.pkh)
      .subscribe((revealed: boolean) => {
        if (!revealed) {
          this.revealFee = 0.0002;
        } else {
          this.revealFee = 0;
        }
        this.checkSource();
      });
  }
  checkSource() {
    if (this.activeAccount instanceof ImplicitAccount) {
      this.recommendedFee = Number(new Big(this.revealFee).plus(this.pkhFee));
    } else if (this.activeAccount instanceof OriginatedAccount) {
      this.recommendedFee = Number(new Big(this.revealFee).plus(this.ktFee));
    }
  }
  getFee() {
    if (this.fee) {
      return this.fee;
    }
    return this.storedFee;
  }
  getDelegate() {
    if (this.toPkh) {
      return this.toPkh;
    }
    return this.storedDelegate;
  }
  clearForm(init: boolean = false) {
    if (!init && this.syncSub) {
      this.syncSub.unsubscribe();
      this.syncSub = undefined;
    }
    this.toPkh = '';
    this.fee = '';
    this.password = '';
    this.pwdValid = '';
    this.formInvalid = '';
    this.sendResponse = '';
    this.ledgerError = '';
    this.domainPendingLookup = false;
  }
  async invalidInput(): Promise<string> {
    // if it is a tezos-domain
    if (this.toPkh && this.toPkh.indexOf('.') > -1) {
      try {
        this.domainPendingLookup = true;
        const { pkh } = await this.tezosDomains.getAddressFromDomain(this.toPkh);
        if (pkh) {
          this.toPkh = pkh;
        } else {
          this.domainPendingLookup = false;
          return 'Could not find the domain';
        }
      } catch (error) {
        return error.message;
      } finally {
        this.domainPendingLookup = false;
      }
    }
    if ((!this.inputValidationService.address(this.toPkh) &&
      this.toPkh !== '') || (
        this.toPkh.length > 1 && this.toPkh.slice(0, 2) !== 'tz') || (
        this.walletService.wallet.getImplicitAccount(this.toPkh))) {
      return 'invalid delegate address';
    } else if (!this.inputValidationService.fee(this.fee)) {
      return 'invalid fee';
    } else {
      return '';
    }
  }
  // Only Numbers with Decimals
  keyPressNumbersDecimal(event, input) {
    const charCode = (event.which) ? event.which : event.keyCode;
    if (charCode !== 46 && charCode > 31
      && (charCode < 48 || charCode > 57)) {
      event.preventDefault();
      return false;
    } else if (charCode === 46 && this[input].length === 0) {
      this[input] = '0' + this[input];
    }
    return true;
  }
  download() {
    this.exportService.downloadOperationData(this.sendResponse.payload.unsignedOperation, false);
  }

  closeModalAction() {
    this.operationResponse.emit(null);
    this.closeModal();
  }

  closeModal() {
    ModalComponent.currentModel.next({ name: '', data: null });
    this.clearForm();
    this.ledgerError = '';
    this.messageService.stopSpinner();
  }

  round(val): string {
    return Math.round(Number(val)).toString();
  }

  toPercent(val): string {
    return parseFloat((Number(val) * 100).toFixed(2)).toString() + '%';
  }
}